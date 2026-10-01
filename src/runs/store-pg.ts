import pg from 'pg';
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

const { Pool } = pg;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  profile text NOT NULL,
  sandbox_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id, last_active_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  profile text NOT NULL,
  state text NOT NULL,
  input text NOT NULL,
  context text,
  result text,
  error text,
  iterations integer NOT NULL DEFAULT 0,
  gateway_calls integer NOT NULL DEFAULT 0,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS runs_session_idx ON runs (session_id, created_at);

CREATE TABLE IF NOT EXISTS run_events (
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  ts timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  tool_call_id text NOT NULL,
  source text NOT NULL,
  name text NOT NULL,
  args jsonb NOT NULL,
  ok boolean NOT NULL,
  result_excerpt text NOT NULL,
  policy_action text NOT NULL,
  duration_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tool_calls_run_idx ON tool_calls (run_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name text NOT NULL,
  sandbox_path text NOT NULL,
  size bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, name)
);

CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  tool_call_id text NOT NULL,
  tool_name text NOT NULL,
  args jsonb NOT NULL,
  status text NOT NULL,
  decided_by text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE (run_id, tool_call_id)
);

CREATE TABLE IF NOT EXISTS sandbox_usage (
  user_id text NOT NULL,
  day date NOT NULL,
  minutes numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS api_keys (
  hash text PRIMARY KEY,
  user_id text NOT NULL,
  label text NOT NULL,
  profile text NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- forward-compat for databases created before session-briefs existed
ALTER TABLE runs ADD COLUMN IF NOT EXISTS context text;
`;

interface RunDbRow {
  id: string;
  session_id: string;
  user_id: string;
  profile: string;
  state: RunState;
  input: string;
  context: string | null;
  result: string | null;
  error: string | null;
  iterations: number;
  gateway_calls: number;
  tokens_in: number;
  tokens_out: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const toRun = (r: RunDbRow): RunRow => ({
  id: r.id,
  sessionId: r.session_id,
  userId: r.user_id,
  profile: r.profile,
  state: r.state,
  input: r.input,
  context: r.context ?? null,
  result: r.result,
  error: r.error,
  iterations: Number(r.iterations ?? 0),
  gatewayCalls: Number(r.gateway_calls ?? 0),
  tokensIn: Number(r.tokens_in ?? 0),
  tokensOut: Number(r.tokens_out ?? 0),
  createdAt: String(r.created_at),
  startedAt: r.started_at ? String(r.started_at) : null,
  finishedAt: r.finished_at ? String(r.finished_at) : null,
});

/**
 * Postgres store (§10). Schema auto-init at startup, same pattern as your
 * gateway's src/schema.ts. Neon connection strings with sslmode=require are
 * normalized to driver ssl options.
 */
export class PgStore implements StorePort {
  private pool: pg.Pool;

  constructor(connectionString: string, max = 5) {
    const noSsl = /localhost|127\.0\.0\.1/.test(connectionString) || !/[?&]sslmode=/.test(connectionString) && !connectionString.includes('neon.tech');
    this.pool = new Pool({
      connectionString,
      max,
      ssl: noSsl ? undefined : { rejectUnauthorized: false },
      connectionTimeoutMillis: 8_000,
    });
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /* journal */
  async append(runId: string, kind: EventKind, payload: Json): Promise<EventRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO run_events (run_id, seq, kind, payload)
       SELECT $1, COALESCE(MAX(seq),0)+1, $2, $3::jsonb FROM run_events WHERE run_id = $1
       RETURNING seq, ts`,
      [runId, kind, JSON.stringify(payload)],
    );
    return { runId, seq: Number(rows[0].seq), kind, payload, ts: String(rows[0].ts) };
  }

  async afterSeq(runId: string, after: number, limit = 500): Promise<EventRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT seq, kind, payload, ts FROM run_events WHERE run_id=$1 AND seq>$2 ORDER BY seq ASC LIMIT $3`,
      [runId, after, limit],
    );
    return rows.map((r) => ({ runId, seq: Number(r.seq), kind: r.kind as EventKind, payload: r.payload as Json, ts: String(r.ts) }));
  }

  /* sessions */
  async createSession(input: { id: string; userId: string; profile: string }): Promise<SessionRow> {
    await this.pool.query(
      `INSERT INTO sessions (id, user_id, profile) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET last_active_at = now()`,
      [input.id, input.userId, input.profile],
    );
    const s = await this.getSession(input.id, input.userId);
    if (!s) throw new Error('session create failed');
    return s;
  }

  async getSession(id: string, userId: string): Promise<SessionRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM sessions WHERE id=$1 AND (user_id=$2 OR $2='master')`, [id, userId]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, userId: r.user_id, profile: r.profile, sandboxId: r.sandbox_id, createdAt: String(r.created_at), lastActiveAt: String(r.last_active_at) };
  }

  async listSessions(userId: string): Promise<SessionRow[]> {
    const { rows } = await this.pool.query(`SELECT * FROM sessions WHERE user_id=$1 ORDER BY last_active_at DESC LIMIT 100`, [userId]);
    return rows.map((r) => ({ id: r.id, userId: r.user_id, profile: r.profile, sandboxId: r.sandbox_id, createdAt: String(r.created_at), lastActiveAt: String(r.last_active_at) }));
  }

  async setSessionSandbox(sessionId: string, sandboxId: string | null): Promise<void> {
    await this.pool.query(`UPDATE sessions SET sandbox_id=$2 WHERE id=$1`, [sessionId, sandboxId]);
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.pool.query(`UPDATE sessions SET last_active_at=now() WHERE id=$1`, [sessionId]);
  }

  /* runs */
  async createRun(input: { id: string; sessionId: string; userId: string; profile: string; state: RunState; input: string; context?: string | null }): Promise<RunRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO runs (id, session_id, user_id, profile, state, input, context) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [input.id, input.sessionId, input.userId, input.profile, input.state, input.input, input.context ?? null],
    );
    return toRun(rows[0]);
  }

  async getRun(id: string): Promise<RunRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM runs WHERE id=$1`, [id]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async listRuns(sessionId: string, limit = 20): Promise<RunRow[]> {
    const { rows } = await this.pool.query(`SELECT * FROM runs WHERE session_id=$1 ORDER BY created_at ASC LIMIT $2`, [sessionId, limit]);
    return rows.map(toRun);
  }

  async updateRun(id: string, patch: Partial<RunRow>): Promise<void> {
    const map: Record<string, [string, unknown]> = {
      state: ['state', patch.state],
      result: ['result', patch.result],
      error: ['error', patch.error],
      iterations: ['iterations', patch.iterations],
      gatewayCalls: ['gateway_calls', patch.gatewayCalls],
      tokensIn: ['tokens_in', patch.tokensIn],
      tokensOut: ['tokens_out', patch.tokensOut],
      startedAt: ['started_at', patch.startedAt],
      finishedAt: ['finished_at', patch.finishedAt],
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const key of Object.keys(patch) as (keyof RunRow)[]) {
      const entry = map[key];
      if (!entry) continue;
      sets.push(`${entry[0]}=$${i++}`);
      vals.push(entry[1]);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this.pool.query(`UPDATE runs SET ${sets.join(', ')} WHERE id=$${i}`, vals);
  }

  async markStaleActiveInterrupted(): Promise<RunRow[]> {
    const { rows } = await this.pool.query(
      `UPDATE runs SET state='interrupted', error='interrupted by process restart — retry the run', finished_at=now()
       WHERE state IN ('queued','running','awaiting_approval') RETURNING *`,
    );
    return rows.map(toRun);
  }

  /* audit + artifacts + approvals */
  async recordToolCall(row: Omit<ToolCallAuditRow, 'id' | 'createdAt'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO tool_calls (id, run_id, tool_call_id, source, name, args, ok, result_excerpt, policy_action, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [uuid(), row.runId, row.toolCallId, row.source, row.name, JSON.stringify(row.args), row.ok, row.resultExcerpt.slice(0, 2048), row.policyAction, row.durationMs],
    );
  }

  async listToolCalls(runId: string): Promise<ToolCallAuditRow[]> {
    const { rows } = await this.pool.query(`SELECT * FROM tool_calls WHERE run_id=$1 ORDER BY created_at`, [runId]);
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      toolCallId: r.tool_call_id,
      source: r.source,
      name: r.name,
      args: r.args,
      ok: r.ok,
      resultExcerpt: r.result_excerpt,
      policyAction: r.policy_action,
      durationMs: Number(r.duration_ms),
      createdAt: String(r.created_at),
    }));
  }

  async addArtifact(row: Omit<ArtifactRow, 'id' | 'createdAt'>): Promise<ArtifactRow> {
    const id = uuid();
    await this.pool.query(
      `INSERT INTO artifacts (id, run_id, name, sandbox_path, size) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (run_id, name) DO UPDATE SET sandbox_path=EXCLUDED.sandbox_path, size=EXCLUDED.size RETURNING *`,
      [id, row.runId, row.name, row.sandboxPath, row.size],
    );
    return { ...row, id, createdAt: new Date().toISOString() };
  }

  async getArtifact(runId: string, name: string): Promise<ArtifactRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM artifacts WHERE run_id=$1 AND name=$2`, [runId, name]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, runId: r.run_id, name: r.name, sandboxPath: r.sandbox_path, size: r.size == null ? null : Number(r.size), createdAt: String(r.created_at) };
  }

  async upsertApproval(row: Omit<ApprovalRow, 'createdAt' | 'decidedAt'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO approvals (id, run_id, tool_call_id, tool_name, args, status, decided_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (run_id, tool_call_id) DO NOTHING`,
      [row.id, row.runId, row.toolCallId, row.toolName, JSON.stringify(row.args), row.status, row.decidedBy, row.note],
    );
  }

  async decideApproval(id: string, status: 'approved' | 'denied', decidedBy: string, note: string | null): Promise<ApprovalRow | null> {
    const { rows } = await this.pool.query(
      `UPDATE approvals SET status=$2, decided_by=$3, note=COALESCE($4, note), decided_at=now() WHERE id=$1 AND status='pending' RETURNING *`,
      [id, status, decidedBy, note],
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id, runId: r.run_id, toolCallId: r.tool_call_id, toolName: r.tool_name, args: r.args,
      status: r.status, decidedBy: r.decided_by, note: r.note, createdAt: String(r.created_at), decidedAt: r.decided_at ? String(r.decided_at) : null,
    };
  }

  async pendingApproval(runId: string, toolCallId: string): Promise<ApprovalRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM approvals WHERE run_id=$1 AND tool_call_id=$2 AND status='pending'`, [runId, toolCallId]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id, runId: r.run_id, toolCallId: r.tool_call_id, toolName: r.tool_name, args: r.args,
      status: r.status, decidedBy: r.decided_by, note: r.note, createdAt: String(r.created_at), decidedAt: r.decided_at ? String(r.decided_at) : null,
    };
  }

  /* quotas + keys */
  async addSandboxMinutes(userId: string, minutes: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO sandbox_usage (user_id, day, minutes) VALUES ($1, CURRENT_DATE, $2) ON CONFLICT (user_id, day) DO UPDATE SET minutes = sandbox_usage.minutes + EXCLUDED.minutes`,
      [userId, minutes],
    );
  }

  async sandboxMinutesToday(userId: string): Promise<number> {
    const { rows } = await this.pool.query(`SELECT minutes FROM sandbox_usage WHERE user_id=$1 AND day=CURRENT_DATE`, [userId]);
    return rows[0] ? Number(rows[0].minutes) : 0;
  }

  async storeApiKey(hash: string, userId: string, label: string, profile: string): Promise<void> {
    await this.pool.query(`INSERT INTO api_keys (hash, user_id, label, profile) VALUES ($1,$2,$3,$4)`, [hash, userId, label, profile]);
  }

  async lookupApiKey(hash: string): Promise<{ userId: string; profile: string; revoked: boolean } | null> {
    const { rows } = await this.pool.query(`SELECT user_id, profile, revoked FROM api_keys WHERE hash=$1`, [hash]);
    if (!rows[0]) return null;
    return { userId: rows[0].user_id, profile: rows[0].profile, revoked: Boolean(rows[0].revoked) };
  }
}
