import type {
  Json,
  JsonObject,
  ToolCall,
  PolicyPort,
  ProfileConfig,
  RunContext,
  StorePort,
  ToolDefinition,
  ToolOutput,
  ToolSource,
} from '../contracts/index.js';
import { PolicyDeniedError } from '../core/errors.js';
import { matchAny, parseJsonSafe, truncateText, withTimeout } from '../core/util.js';
import { validateArgs } from './validate.js';

export type ApprovalGate = (def: ToolDefinition, args: JsonObject, ctx: RunContext, toolCallId: string) => Promise<'approved' | 'denied' | 'timeout'>;

export interface RegistryDeps {
  policy: PolicyPort;
  store: StorePort;
  toolResultMaxBytes: number;
}

/**
 * ToolRegistry — composition of ToolSources (§11.1-3).
 * The loop sees exactly one thing: {definitions, execute}. It never learns
 * whether a tool is a builtin, an E2B call, or an MCP hop.
 */
export class ToolRegistry {
  private sources: ToolSource[] = [];
  private approvalGate: ApprovalGate | null = null;

  constructor(private readonly deps: RegistryDeps) {}

  register(source: ToolSource): void {
    if (this.sources.some((s) => s.id === source.id)) throw new Error(`ToolSource id collision: ${source.id}`);
    this.sources.push(source);
  }

  /** Late wiring seam (the run engine sets this at startup; keeps deps acyclic). */
  setApprovalGate(gate: ApprovalGate): void {
    this.approvalGate = gate;
  }

  /** Merge enabled sources' tools for this profile: allow-filter + fail-fast collision. */
  async definitions(profile: ProfileConfig): Promise<{ defs: ToolDefinition[]; byName: Map<string, { source: ToolSource; def: ToolDefinition }> }> {
    const byName = new Map<string, { source: ToolSource; def: ToolDefinition }>();
    const defs: ToolDefinition[] = [];
    for (const source of this.sources) {
      let enabled = true;
      try {
        enabled = await source.enabled();
      } catch {
        enabled = false;
      }
      if (!enabled) continue;
      let tools: ToolDefinition[] = [];
      try {
        tools = await source.listTools({});
      } catch {
        continue; // degraded source → its tools drop out; a run never hard-fails on it
      }
      for (const def of tools) {
        if (!matchAny(profile.toolAllow, def.name)) continue;
        if (matchAny(profile.deny, def.name)) continue;
        if (!profile.sandboxEnabled && def.sourceId === 'sandbox') continue;
        if (byName.has(def.name)) throw new Error(`Tool name collision at boot: "${def.name}" (fail fast — §11.1-3)`);
        byName.set(def.name, { source, def });
        defs.push(def);
      }
    }
    return { defs, byName };
  }

  /**
   * Validate → policy → (approval) → execute → truncate → scrub → wrap.
   * Model-visible failures return as {ok:false} tool results; throws only for
   * orchestrator-internal problems.
   */
  async execute(call: ToolCall, ctx: RunContext, byName: Map<string, { source: ToolSource; def: ToolDefinition }>): Promise<ToolOutput> {
    const raw = { id: call.id, name: call.function.name, arguments: call.function.arguments };
    const started = Date.now();
    const entry = byName.get(raw.name);
    const finish = (out: ToolOutput, def?: ToolDefinition, args: JsonObject = {}, action: 'allow' | 'review' | 'deny' = 'allow'): ToolOutput => {
      void this.audit(ctx, raw, out, def, args, action, Date.now() - started);
      return out;
    };

    if (!entry) {
      return finish({ ok: false, content: `Unknown tool "${raw.name}" — it is not in this run's registry. Do not retry it; adjust your plan.` });
    }
    const { source, def } = entry;

    const parsedArgs = parseJsonSafe(raw.arguments || '{}');
    if (!parsedArgs.ok) {
      return finish({ ok: false, content: `Invalid JSON in arguments: ${parsedArgs.error}. Retry once with valid JSON matching the schema.` }, def);
    }
    const argsObj: JsonObject = typeof parsedArgs.value === 'object' && parsedArgs.value !== null && !Array.isArray(parsedArgs.value) ? (parsedArgs.value as JsonObject) : {};

    const errors = validateArgs(def.parameters, argsObj);
    if (errors.length > 0) {
      return finish({ ok: false, content: `Argument validation failed: ${errors.join('; ')}` }, def, argsObj);
    }

    const decision = this.deps.policy.check(def, argsObj, ctx);
    if (decision.action === 'deny') {
      return finish({ ok: false, content: `Blocked by orchestrator policy: ${decision.reason}. Do not retry this call or reword it. Offer the user an alternative in your answer.` }, def, argsObj, 'deny');
    }

    if (decision.action === 'review') {
      if (!this.approvalGate) {
        return finish({ ok: false, content: `This action requires human approval (${decision.reason}) but no approval channel is available. Explain this to the user.` }, def, argsObj, 'review');
      }
      const verdict = await this.approvalGate(def, argsObj, ctx, raw.id);
      if (verdict !== 'approved') {
        return finish(
          { ok: false, content: verdict === 'timeout' ? 'Approval timed out; the action was not executed.' : 'A human denied this approval request. Do not retry; adjust your plan and explain.' },
          def,
          argsObj,
          'review',
        );
      }
    }

    let out: ToolOutput;
    try {
      if (ctx.signal.aborted) return finish({ ok: false, content: 'run cancelled before execution' }, def, argsObj, decision.action);
      out = await withTimeout(source.execute(def, argsObj, ctx), Math.max(def.timeoutMs, 5_000), `tool ${def.name}`);
    } catch (err) {
      if (err instanceof PolicyDeniedError) return finish({ ok: false, content: `Blocked by policy: ${err.message}` }, def, argsObj, 'deny');
      const message = err instanceof Error ? err.message : String(err);
      return finish({ ok: false, content: `Tool execution failed: ${this.deps.policy.scrub(message).slice(0, 800)}` }, def, argsObj, decision.action);
    }

    const rawText = typeof out?.content === 'string' ? out.content : JSON.stringify(out ?? '');
    const { text } = truncateText(rawText, this.deps.toolResultMaxBytes);
    const scrubbed = this.deps.policy.scrub(text);
    const finalText = def.external ? this.deps.policy.wrap(def.sourceId, scrubbed) : scrubbed;
    const ok = out.ok === true;
    return finish({ ok, content: finalText, meta: out.meta }, def, argsObj, decision.action);
  }

  /** Admin/debug view of every tool across sources. */
  async listAllForAdmin(): Promise<Json[]> {
    const out: Json[] = [];
    for (const s of this.sources) {
      const enabled = await s.enabled().catch(() => false);
      const tools = enabled ? await s.listTools({}).catch(() => []) : [];
      for (const t of tools) {
        out.push({ source: s.id, kind: s.kind, name: t.name, description: t.description, external: t.external, mutating: t.mutating, timeout_ms: t.timeoutMs });
      }
    }
    return out;
  }

  private async audit(
    ctx: RunContext,
    raw: { id: string; name: string; arguments: string },
    out: ToolOutput,
    def: ToolDefinition | undefined,
    args: JsonObject,
    action: 'allow' | 'review' | 'deny',
    durationMs: number,
  ): Promise<void> {
    try {
      await this.deps.store.recordToolCall({
        runId: ctx.runId,
        toolCallId: raw.id,
        source: def?.sourceId ?? 'unknown',
        name: raw.name,
        args,
        ok: out.ok,
        resultExcerpt: truncateText(out.content, 2048).text,
        policyAction: action,
        durationMs,
      });
    } catch {
      /* audit must never break the loop (mirrors the gateway's telemetry policy) */
    }
  }
}
