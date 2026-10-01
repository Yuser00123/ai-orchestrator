import type {
  ApprovalRow,
  ArtifactRow,
  EventKind,
  EventRecord,
  Json,
  RunRow,
  RunState,
  SessionRow,
  StorePort,
  ToolCallAuditRow,
} from '../contracts/index.js';
import { uuid } from '../core/util.js';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Dev/test store. Same surface as the Postgres store (store-pg.ts). */
export class MemoryStore implements StorePort {
  private sessions = new Map<string, SessionRow>();
  private runs = new Map<string, RunRow>();
  private events: EventRecord[] = [];
  private seqByRun = new Map<string, number>();
  private toolCalls: ToolCallAuditRow[] = [];
  private artifacts = new Map<string, ArtifactRow>();
  private approvals = new Map<string, ApprovalRow>();
  private sandboxMinutes = new Map<string, number>();
  private apiKeys = new Map<string, { userId: string; profile: string; revoked: boolean }>();

  /* journal */
  async append(runId: string, kind: EventKind, payload: Json): Promise<EventRecord> {
    const seq = (this.seqByRun.get(runId) ?? 0) + 1;
    this.seqByRun.set(runId, seq);
    const rec: EventRecord = { runId, seq, kind, payload, ts: new Date().toISOString() };
    this.events.push(rec);
    return rec;
  }

  async afterSeq(runId: string, after: number, limit = 500): Promise<EventRecord[]> {
    return this.events.filter((e) => e.runId === runId && e.seq > after).slice(0, limit).map(clone);
  }

  /* sessions */
  async createSession(input: { id: string; userId: string; profile: string }): Promise<SessionRow> {
    const existing = this.sessions.get(input.id);
    if (existing && existing.userId === input.userId) return clone(existing);
    if (existing) throw new Error('session id belongs to another user');
    const row: SessionRow = {
      id: input.id,
      userId: input.userId,
      profile: input.profile,
      sandboxId: null,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    this.sessions.set(row.id, row);
    return clone(row);
  }

  async getSession(id: string, userId: string): Promise<SessionRow | null> {
    const s = this.sessions.get(id);
    return s && (s.userId === userId || userId === 'master') ? clone(s) : null;
  }

  async listSessions(userId: string): Promise<SessionRow[]> {
    return [...this.sessions.values()].filter((s) => s.userId === userId).map(clone);
  }

  async setSessionSandbox(sessionId: string, sandboxId: string | null): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.sandboxId = sandboxId;
  }

  async touchSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.lastActiveAt = new Date().toISOString();
  }

  /* runs */
  async createRun(input: { id: string; sessionId: string; userId: string; profile: string; state: RunState; input: string; context?: string | null }): Promise<RunRow> {
    const row: RunRow = {
      id: input.id,
      sessionId: input.sessionId,
      userId: input.userId,
      profile: input.profile,
      state: input.state,
      input: input.input,
      context: input.context ?? null,
      result: null,
      error: null,
      iterations: 0,
      gatewayCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    this.runs.set(row.id, row);
    return clone(row);
  }

  async getRun(id: string): Promise<RunRow | null> {
    const r = this.runs.get(id);
    return r ? clone(r) : null;
  }

  async listRuns(sessionId: string, limit = 20): Promise<RunRow[]> {
    return [...this.runs.values()]
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-limit)
      .map(clone);
  }

  async updateRun(id: string, patch: Partial<RunRow>): Promise<void> {
    const r = this.runs.get(id);
    if (r) Object.assign(r, patch);
  }

  async markStaleActiveInterrupted(): Promise<RunRow[]> {
    const stale = [...this.runs.values()].filter((r) => ['queued', 'running', 'awaiting_approval'].includes(r.state));
    for (const r of stale) {
      r.state = 'interrupted';
      r.error = 'interrupted by process restart — retry the run';
      r.finishedAt = new Date().toISOString();
    }
    return stale.map(clone);
  }

  /* audit + artifacts + approvals */
  async recordToolCall(row: Omit<ToolCallAuditRow, 'id' | 'createdAt'>): Promise<void> {
    this.toolCalls.push({ ...row, id: uuid(), createdAt: new Date().toISOString() });
    if (this.toolCalls.length > 20_000) this.toolCalls.splice(0, 5_000);
  }

  async listToolCalls(runId: string): Promise<ToolCallAuditRow[]> {
    return this.toolCalls.filter((t) => t.runId === runId).map(clone);
  }

  async addArtifact(row: Omit<ArtifactRow, 'id' | 'createdAt'>): Promise<ArtifactRow> {
    const full: ArtifactRow = { ...row, id: uuid(), createdAt: new Date().toISOString() };
    this.artifacts.set(`${row.runId}:${row.name}`, full);
    return clone(full);
  }

  async getArtifact(runId: string, name: string): Promise<ArtifactRow | null> {
    const a = this.artifacts.get(`${runId}:${name}`);
    return a ? clone(a) : null;
  }

  async upsertApproval(row: Omit<ApprovalRow, 'createdAt' | 'decidedAt'>): Promise<void> {
    this.approvals.set(row.id, { ...row, createdAt: new Date().toISOString(), decidedAt: null });
  }

  async decideApproval(id: string, status: 'approved' | 'denied', decidedBy: string, note: string | null): Promise<ApprovalRow | null> {
    const a = this.approvals.get(id);
    if (!a || a.status !== 'pending') return null;
    a.status = status;
    a.decidedBy = decidedBy;
    a.note = note;
    a.decidedAt = new Date().toISOString();
    return clone(a);
  }

  async pendingApproval(runId: string, toolCallId: string): Promise<ApprovalRow | null> {
    for (const a of this.approvals.values()) if (a.runId === runId && a.toolCallId === toolCallId && a.status === 'pending') return clone(a);
    return null;
  }

  /* quotas + keys */
  async addSandboxMinutes(userId: string, minutes: number): Promise<void> {
    const key = `${userId}:${new Date().toISOString().slice(0, 10)}`;
    this.sandboxMinutes.set(key, (this.sandboxMinutes.get(key) ?? 0) + minutes);
  }

  async sandboxMinutesToday(userId: string): Promise<number> {
    return this.sandboxMinutes.get(`${userId}:${new Date().toISOString().slice(0, 10)}`) ?? 0;
  }

  async storeApiKey(hash: string, userId: string, label: string, profile: string): Promise<void> {
    void label;
    this.apiKeys.set(hash, { userId, profile, revoked: false });
  }

  async lookupApiKey(hash: string): Promise<{ userId: string; profile: string; revoked: boolean } | null> {
    const k = this.apiKeys.get(hash);
    return k ? { ...k } : null;
  }
}
