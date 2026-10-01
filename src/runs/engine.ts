import type {
  ChatMessage,
  JsonObject,
  LLM,
  MemoryPort,
  PolicyPort,
  ProfileConfig,
  RunContext,
  RunRow,
  SessionRow,
  SkillsPort,
  StorePort,
  ToolDefinition,
} from '../contracts/index.js';
import { uuid } from '../core/util.js';
import type { ToolRegistry } from '../tools/index.js';
import { buildSystemPrompt, composeTranscript, maybeCompact } from './context.js';

export interface RunInput {
  run: RunRow;
  session: SessionRow;
  userMessage: string;
}

export interface EngineDeps {
  llm: LLM;
  registry: ToolRegistry;
  policy: PolicyPort;
  store: StorePort;
  skills: SkillsPort;
  memory: MemoryPort;
  profiles: Map<string, ProfileConfig>;
  gatewayMaxCallsPerRun: number;
  approvalTimeoutMs: number;
}

type Verdict = 'approved' | 'denied' | 'timeout';
type ApprovalWaiter = { resolve: (v: Verdict) => void };

interface ActiveRun {
  ctx: RunContext;
  approvals: Map<string, ApprovalWaiter>;
  cancel: () => void;
}

/**
 * RunEngine — the agent loop (§4 of the plan). Owns iteration:
 * gateway call → parse tool_calls → registry.execute (validate/policy/gate)
 * → feed results back → repeat until finish_reason=stop.
 * Budgets: iterations, wall-clock, gateway calls. Guards: identical-call
 * repeat detection, consecutive-failure nudge, context compaction.
 */
export class RunEngine {
  private active = new Map<string, ActiveRun>();

  constructor(private readonly d: EngineDeps) {
    // wire the approval gate into the registry (single seam, no circular deps)
    this.d.registry.setApprovalGate(async (def, args, ctx, toolCallId) => {
      const active = this.active.get(ctx.runId);
      if (!active) return 'denied';
      return this.requestApproval(active, def, args, toolCallId);
    });
  }

  activeRunIds(): string[] {
    return [...this.active.keys()];
  }

  async start(input: RunInput): Promise<void> {
    const profile = this.d.profiles.get(input.run.profile) ?? this.d.profiles.get('code');
    if (!profile) throw new Error(`unknown profile "${input.run.profile}" and no "code" fallback`);
    const ac = new AbortController();
    const ctx: RunContext = {
      runId: input.run.id,
      sessionId: input.session.id,
      userId: input.run.userId,
      agentId: `usr-${input.run.userId}`,
      profile,
      signal: ac.signal,
      now: () => new Date(),
    };
    const active: ActiveRun = { ctx, approvals: new Map(), cancel: () => ac.abort() };
    this.active.set(input.run.id, active);

    try {
      await this.d.store.updateRun(input.run.id, { state: 'running', startedAt: new Date().toISOString() });
      await this.d.store.append(input.run.id, 'run_started', { session_id: input.session.id, profile: profile.name, route: profile.route });
      await this.runLoop(input, active);
    } catch (err) {
      if (ac.signal.aborted || (err instanceof Error && err.message === 'cancelled')) {
        await this.finish(input.run.id, 'cancelled', null, 'run cancelled');
        await this.d.store.append(input.run.id, 'run_cancelled', { reason: 'cancelled by client' });
      } else {
        const message = this.d.policy.scrub(err instanceof Error ? err.message : String(err)).slice(0, 900);
        await this.d.store.append(input.run.id, 'error', { message });
        await this.finish(input.run.id, 'failed', null, message);
        await this.d.store.append(input.run.id, 'run_failed', { message });
      }
    } finally {
      this.active.delete(input.run.id);
      for (const w of active.approvals.values()) w.resolve('denied');
      active.approvals.clear();
    }
  }

  cancel(runId: string): boolean {
    const a = this.active.get(runId);
    if (!a) return false;
    a.cancel();
    return true;
  }

  decide(runId: string, toolCallId: string, decision: 'approved' | 'denied'): boolean {
    const w = this.active.get(runId)?.approvals.get(toolCallId);
    if (!w) return false;
    w.resolve(decision);
    return true;
  }

  /* ------------------------------------------------------------------ */

  private async runLoop(input: RunInput, active: ActiveRun): Promise<void> {
    const { ctx } = active;
    const profile = ctx.profile;
    const deadline = Date.now() + profile.wallclockMs;
    const { defs, byName } = await this.d.registry.definitions(profile);

    const manifest = this.d.skills.ready() ? await this.d.skills.manifestText() : '';
    const recall = await this.d.memory.recall({ agentId: ctx.agentId, sessionId: ctx.sessionId });
    if (recall) await this.d.store.append(ctx.runId, 'recall_injected', { chars: recall.length });
    const history = await this.loadHistory(input.session.id, input.run.id);
    const brief = input.run.context ?? (await this.latestBrief(input.session.id, input.run.id));

    const messages: ChatMessage[] = [
      { role: 'system', content: await buildSystemPrompt({ profile, manifest, recall }) },
      ...(brief ? [{ role: 'user' as const, content: `[session brief — durable ground rules set by the user; they apply to every turn of this session]\n${brief}` }] : []),
      ...composeTranscript(history, input.userMessage),
    ];

    const callHistory = new Map<string, number>();
    const usedToolNames = new Set<string>();
    let consecutiveErrors = 0;
    let iterations = 0;
    let gatewayCalls = 0;
    let tokensIn = 0;
    let tokensOut = 0;

    for (;;) {
      if (ctx.signal.aborted) throw new Error('cancelled');
      if (Date.now() > deadline) throw new Error(`run exceeded wall-clock budget (${profile.wallclockMs} ms)`);
      if (iterations >= profile.loopMaxIterations) throw new Error(`iteration budget exhausted (${profile.loopMaxIterations}) without a final answer`);
      if (gatewayCalls >= this.d.gatewayMaxCallsPerRun) throw new Error(`gateway call budget exhausted (${this.d.gatewayMaxCallsPerRun}) for this run`);

      const compacted = await maybeCompact({
        llm: this.d.llm,
        agentId: ctx.agentId,
        messages,
        budget: profile.contextTokenBudget,
        route: profile.route,
        onCompact: (info) => this.d.store.append(ctx.runId, 'compaction', info),
      });
      if (compacted) await this.d.store.append(ctx.runId, 'status', { status: compacted });

      await this.d.store.append(ctx.runId, 'model_step', { iteration: iterations + 1, route: profile.route, message_count: messages.length });
      gatewayCalls++;

      const reply = await this.d.llm.complete({
        model: profile.route,
        messages,
        tools: defs.length > 0 ? defs : undefined,
        temperature: profile.temperature,
        agentId: ctx.agentId,
        signal: ctx.signal,
      });
      if (reply.usage) {
        tokensIn += reply.usage.prompt_tokens;
        tokensOut += reply.usage.completion_tokens;
        await this.d.store.append(ctx.runId, 'usage', {
          prompt: reply.usage.prompt_tokens,
          completion: reply.usage.completion_tokens,
          provider: reply.provider ?? null,
          model: reply.model ?? null,
        });
      }

      iterations++;
      await this.d.store.append(ctx.runId, 'assistant_turn', { content_preview: (reply.message.content ?? '').slice(0, 400), provider: reply.provider ?? null });
      await this.d.store.updateRun(ctx.runId, { iterations, gatewayCalls, tokensIn, tokensOut });

      const toolCalls = reply.message.tool_calls ?? [];
      const finalAnswer = reply.message.content?.trim() ?? '';

      if (reply.finishReason !== 'tool_calls' || toolCalls.length === 0) {
        const out = finalAnswer || 'The model produced no final answer.';
        await this.finish(input.run.id, 'completed', out, null, { iterations, gatewayCalls, tokensIn, tokensOut });
        await this.d.store.append(ctx.runId, 'run_finished', { iterations, gateway_calls: gatewayCalls, model: reply.model ?? profile.route });
        if (profile.memoryWriteback) void this.writeback(input.userMessage, ctx, out, usedToolNames);
        return;
      }

      // keep the assistant turn (with tool_calls) in the transcript for provider continuity
      messages.push(reply.message);

      const allParallel = toolCalls.every((tc) => byName.get(tc.function.name)?.def.parallelSafe !== false);
      const runOne = async (tc: (typeof toolCalls)[number]) => {
        usedToolNames.add(tc.function.name);
        const out = await this.d.registry.execute(tc, ctx, byName);
        return { tc, out };
      };
      const results = allParallel && toolCalls.length > 1 ? await Promise.all(toolCalls.map(runOne)) : [];
      if (results.length === 0) for (const tc of toolCalls) results.push(await runOne(tc));

      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.tc.id, name: r.tc.function.name, content: r.out.content });

        const key = `${r.tc.function.name}:${r.tc.function.arguments}`;
        const seen = (callHistory.get(key) ?? 0) + 1;
        callHistory.set(key, seen);
        if (seen >= 3) {
          messages.push({ role: 'user', content: `[orchestrator guard] You have made this identical call ${seen} times (${key.slice(0, 140)}). Stop retrying it. Proceed with what you have or state the blocker in your final answer.` });
        }
        consecutiveErrors = r.out.ok ? 0 : consecutiveErrors + 1;
      }
      if (consecutiveErrors >= 3) {
        messages.push({ role: 'user', content: '[orchestrator guard] Several consecutive tool failures. Change approach (different tool/arguments) or report the blocker; do not brute-force.' });
        consecutiveErrors = 0;
      }
    }
  }

  private async requestApproval(active: ActiveRun, def: ToolDefinition, args: JsonObject, toolCallId: string): Promise<Verdict> {
    const ctx = active.ctx;
    const approvalId = uuid();
    await this.d.store.upsertApproval({ id: approvalId, runId: ctx.runId, toolCallId, toolName: def.name, args, status: 'pending', decidedBy: null, note: null });
    await this.d.store.append(ctx.runId, 'approval_requested', {
      approval_id: approvalId,
      tool_call_id: toolCallId,
      tool: def.name,
      args_preview: this.d.policy.scrub(JSON.stringify(args)).slice(0, 400),
    });
    await this.d.store.updateRun(ctx.runId, { state: 'awaiting_approval' });

    return new Promise<Verdict>((resolve) => {
      let settled = false;
      const settle = (v: Verdict, decidedBy: string, note: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        active.approvals.delete(toolCallId);
        if (v !== 'timeout') void this.d.store.decideApproval(approvalId, v === 'approved' ? 'approved' : 'denied', decidedBy, note);
        void this.d.store.append(ctx.runId, 'approval_resolved', { approval_id: approvalId, decision: v });
        void this.d.store.updateRun(ctx.runId, { state: 'running' });
        resolve(v);
      };
      const timer = setTimeout(() => settle('timeout', 'system', 'timed out'), this.d.approvalTimeoutMs);
      timer.unref?.();
      const onAbort = (): void => settle('denied', 'system', 'run cancelled while awaiting approval');
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      active.approvals.set(toolCallId, { resolve: (v) => settle(v, 'user', null) });
    });
  }

  /** Newest explicit brief in this session, so later turns inherit the rules without resending. */
  private async latestBrief(sessionId: string, currentRunId: string): Promise<string | null> {
    const runs = await this.d.store.listRuns(sessionId, 20);
    for (let i = runs.length - 1; i >= 0; i--) {
      const r = runs[i];
      if (r.id !== currentRunId && r.context) return r.context;
    }
    return null;
  }

  private async loadHistory(sessionId: string, currentRunId: string): Promise<{ user: string; assistant: string }[]> {
    const runs = await this.d.store.listRuns(sessionId, 12);
    return runs
      .filter((r) => r.id !== currentRunId && r.state === 'completed' && r.result)
      .slice(-8)
      .map((r) => ({ user: r.input.slice(0, 800), assistant: String(r.result).slice(0, 1600) }));
  }

  private async writeback(userMessage: string, ctx: RunContext, finalText: string, tools: Set<string>): Promise<void> {
    try {
      const gist = `Turn ${new Date().toISOString()}: asked "${userMessage.slice(0, 260)}"; tools: ${[...tools].slice(0, 10).join(', ') || 'none'}; result: ${finalText.slice(0, 380)}`;
      await this.d.memory.writeback({ agentId: ctx.agentId, sessionId: ctx.sessionId, gist });
    } catch {
      /* durable writeback never fails a run */
    }
  }

  private async finish(
    runId: string,
    state: 'completed' | 'failed' | 'cancelled',
    result: string | null,
    error: string | null,
    counts?: Partial<RunRow>,
  ): Promise<void> {
    await this.d.store.updateRun(runId, { state, result, error, finishedAt: new Date().toISOString(), ...counts });
  }
}
