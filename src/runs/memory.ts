import type { MemoryPort } from '../contracts/index.js';
import type { GatewayClient } from '../gateway/index.js';

/**
 * MemoryPort — durable recall via the GATEWAY's /v1/memories (the gateway owns
 * memory; we only write/read it; §6 D1). All ops best-effort.
 */
export class GatewayMemory implements MemoryPort {
  constructor(private readonly client: GatewayClient, private readonly enabled: boolean) {}

  async recall(ctx: { agentId: string; sessionId: string }): Promise<string> {
    if (!this.enabled) return '';
    const rows = await this.client.listMemories(ctx.agentId, ctx.sessionId);
    if (rows.length === 0) return '';
    return rows.map((m) => `- (${m.kind}, ${m.importance.toFixed(1)}) ${m.content.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n').slice(0, 4000);
  }

  async writeback(ctx: { agentId: string; sessionId: string; gist: string; preference?: string | null }): Promise<void> {
    if (!this.enabled) return;
    await this.client.postMemory(ctx.agentId, { kind: 'session', content: ctx.gist, sessionId: ctx.sessionId, importance: 0.55 });
    const pref = detectPreference(ctx.gist) ?? ctx.preference;
    if (pref) await this.client.postMemory(ctx.agentId, { kind: 'semantic', content: pref, sessionId: ctx.sessionId, importance: 0.85 });
  }
}

/** No-op implementation (tests / gateway key absent). */
export class NullMemory implements MemoryPort {
  async recall(): Promise<string> {
    return '';
  }
  async writeback(): Promise<void> {
    /* nothing */
  }
}

const PREFERENCE = /(?:remember (?:that )?|i (?:prefer|like|use)|my name is|always |never |my preferred format is)\s*[:\s]([^\n"]{6,240})/i;

function detectPreference(gist: string): string | null {
  const m = gist.match(PREFERENCE);
  if (!m) return null;
  const text = m[1].trim();
  return text.length > 6 ? `User preference captured by orchestrator: ${text.slice(0, 240)}` : null;
}
