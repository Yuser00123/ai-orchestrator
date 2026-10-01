import { randomUUID } from 'node:crypto';
import type { ChatMessage, LLM, LLMReply, LLMRequest } from '../contracts/index.js';
import { GatewayError } from '../core/errors.js';
import { sleep } from '../core/util.js';

/**
 * Gateway client — the LLM port. Talks to the Unified AI Memory Gateway
 * (see API_DOCUMENTATION.md). Rules learned from the doc:
 *  - tool workflows MUST be non-streaming (§9)
 *  - transient statuses (408,409,425,429,5xx) → backoff; connect errors →
 *    "warming/restarting" retry; body >2MiB → our truncation prevents it,
 *    but map 413 explicitly
 *  - x-gateway-* headers capture which provider/model answered (§8.4)
 */

export interface GatewayClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524]);

export class GatewayClient implements LLM {
  constructor(private readonly opts: GatewayClientOptions) {}

  async complete(req: LLMRequest): Promise<LLMReply> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: false,
      temperature: req.temperature,
    };
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }
    const { res, json } = await this.post('/v1/chat/completions', body, req);

    const choice = (json as { choices?: unknown[] })?.choices?.[0] as
      | { message?: ChatMessage; finish_reason?: string }
      | undefined;
    if (!choice?.message) throw new GatewayError('gateway returned no choices', res.status, true, 'no_choices');

    const usageRaw = (json as { usage?: LLMReply['usage'] })?.usage ?? null;
    return {
      message: normalizeMessage(choice.message),
      finishReason: choice.finish_reason ?? 'stop',
      usage: usageRaw
        ? {
            prompt_tokens: Number(usageRaw.prompt_tokens ?? 0),
            completion_tokens: Number(usageRaw.completion_tokens ?? 0),
            total_tokens: Number(usageRaw.total_tokens ?? 0),
          }
        : null,
      provider: res.headers.get('x-gateway-provider') ?? undefined,
      model: res.headers.get('x-gateway-model') ?? (json as { model?: string })?.model,
    };
  }

  /** durable-memory recall for run start (§6 write-back design). Best-effort. */
  async listMemories(agentId: string, sessionId: string, limit = 12): Promise<{ content: string; kind: string; importance: number }[]> {
    try {
      const { json } = await this.post('/v1/memories', null, { agentId }, { method: 'GET', query: { session_id: sessionId } });
      const data = (json as { data?: unknown[] })?.data ?? [];
      return data
        .slice(0, limit)
        .map((m) => m as { content?: string; kind?: string; importance?: number })
        .filter((m) => typeof m.content === 'string')
        .map((m) => ({ content: String(m.content), kind: String(m.kind ?? 'semantic'), importance: Number(m.importance ?? 0.5) }))
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 6);
    } catch {
      return [];
    }
  }

  async postMemory(agentId: string, mem: { kind: string; content: string; sessionId: string; importance: number }): Promise<void> {
    try {
      await this.post('/v1/memories', { kind: mem.kind, content: mem.content.slice(0, 9000), session_id: mem.sessionId, importance: mem.importance }, { agentId });
    } catch {
      /* memory writes must never fail a run (mirrors gateway's telemetry policy) */
    }
  }

  /** public liveness — used by /ready */
  async health(): Promise<boolean> {
    try {
      const r = await fetch(`${this.opts.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  private async post(
    pathname: string,
    jsonBody: unknown,
    meta: { agentId: string; sessionId?: string },
    opts: { method?: 'POST' | 'GET'; query?: Record<string, string> } = {},
  ): Promise<{ res: Response; json: unknown }> {
    const method = opts.method ?? 'POST';
    let attempt = 0;
    let lastErr = 'unknown';
    for (;;) {
      const ac = AbortSignal.timeout(this.opts.timeoutMs);
      const url = new URL(pathname, this.opts.baseUrl);
      for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.opts.apiKey}`,
            'content-type': 'application/json',
            'x-agent-id': meta.agentId,
            'x-request-id': randomUUID(),
            ...(meta.sessionId ? { 'x-session-id': meta.sessionId } : {}),
          },
          body: method === 'POST' ? JSON.stringify(jsonBody) : undefined,
          signal: ac,
        });
      } catch (err) {
        // connect refused / abort / fetch failure → instance probably warming or restarting
        lastErr = err instanceof Error ? err.message : String(err);
        if (attempt++ < this.opts.maxRetries) {
          await sleep(this.retryDelay(attempt, null));
          continue;
        }
        throw new GatewayError(`gateway unreachable (${lastErr}) — is it deployed/asleep?`, 503, true, 'gateway_unreachable');
      }

      if (res.ok) {
        try {
          return { res, json: await res.json() };
        } catch {
          lastErr = 'invalid JSON from gateway';
          if (attempt++ < this.opts.maxRetries) {
            await sleep(this.retryDelay(attempt, null));
            continue;
          }
          throw new GatewayError(lastErr, 502, true, 'bad_gateway_json');
        }
      }

      const text = (await res.text().catch(() => '')).slice(0, 500);
      let code = 'gateway_error';
      let message = `gateway HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
        if (parsed?.error) {
          code = parsed.error.code ?? code;
          message = `gateway error ${res.status}: ${parsed.error.message ?? code}`;
        }
      } catch {
        /* non-JSON error page — treat retryable statuses as transient */
      }
      if (res.status === 413) throw new GatewayError('request body too large (gateway 2MiB cap)', 413, false, 'body_too_large');
      if (res.status === 401) throw new GatewayError('gateway rejected API key (401) — check GATEWAY_API_KEY', 401, false, 'invalid_api_key');
      if (RETRYABLE_STATUS.has(res.status) && attempt < this.opts.maxRetries) {
        await sleep(this.retryDelay(attempt + 1, res.headers.get('retry-after')));
        attempt++;
        continue;
      }
      throw new GatewayError(message, res.status, RETRYABLE_STATUS.has(res.status), code);
    }
  }

  private retryDelay(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs)) return Math.min(15_000, Math.max(250, secs * 1000));
    }
    return Math.min(15_000, this.opts.retryBaseMs * 2 ** (attempt - 1)) + Math.floor(Math.random() * 150);
  }
}

function normalizeMessage(m: ChatMessage): ChatMessage {
  const out: ChatMessage = { role: 'assistant', content: typeof m?.content === 'string' ? m.content : null };
  const calls = m?.tool_calls;
  if (Array.isArray(calls) && calls.length > 0) {
    out.tool_calls = calls
      .filter((c) => c?.id && c?.function?.name)
      .map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.function.name, arguments: c.function.arguments ?? '{}' } }));
  }
  return out;
}

/** Deterministic stand-in for tests / LLM_MODE=mock. Not usable in production. */
export class MockLlm implements LLM {
  private calls = 0;
  async complete(req: LLMRequest): Promise<LLMReply> {
    this.calls++;
    const hasToolResults = req.messages.some((m) => m.role === 'tool');
    const wantsTool = !hasToolResults && req.tools && req.tools.length > 0 && this.calls === 1;
    if (wantsTool) {
      return {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: `mock-call-${this.calls}`, type: 'function', function: { name: 'orch.time_now', arguments: '{}' } }],
        },
        finishReason: 'tool_calls',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        provider: 'mock',
        model: 'mock-llm',
      };
    }
    return {
      message: { role: 'assistant', content: 'Mock answer complete. (LLM_MODE=mock — wire GATEWAY_BASE_URL/GATEWAY_API_KEY for real runs.)' },
      finishReason: 'stop',
      usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 },
      provider: 'mock',
      model: 'mock-llm',
    };
  }
}
