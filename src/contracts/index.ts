/**
 * src/contracts — THE dependency hub (§11 of ORCHESTRATOR_PLAN.md).
 * All shared types/interfaces live here. Modules import types from
 * `contracts` and never from another module's internals.
 * This file must stay dependency-free (type-only, no runtime imports).
 */

/* ---------- JSON ---------- */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

/* ---------- OpenAI-compatible chat shapes ---------- */
export type Role = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/* ---------- Tools ---------- */
export interface JsonSchema {
  type: 'object';
  properties?: Record<string, Json> | undefined;
  required?: string[] | undefined;
  [k: string]: Json | undefined;
}

export interface ToolDefinition {
  /** Namespaced name as presented to the model: orch.* | sandbox.* | mcp__server__tool */
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Which ToolSource provided it (builtin id, 'sandbox', 'mcp:<serverId>') */
  sourceId: string;
  /** Output is untrusted external content → must pass through Policy.wrap() */
  external: boolean;
  /** Capability can change state (host files, remote services) → policy review tier */
  mutating: boolean;
  /** Per-call execution timeout */
  timeoutMs: number;
  parallelSafe: boolean;
}

export interface ToolOutput {
  ok: boolean;
  content: string;
  meta?: JsonObject;
}

export interface RunContext {
  runId: string;
  sessionId: string;
  userId: string;
  /** Derived gateway identity: usr-<userId> */
  agentId: string;
  profile: ProfileConfig;
  signal: AbortSignal;
  now: () => Date;
}

export interface ToolSource {
  id: string;
  kind: 'builtin' | 'sandbox' | 'mcp';
  /** Filter itself out (missing key/config) rather than throwing. */
  enabled(ctx?: Partial<RunContext>): Promise<boolean>;
  listTools(ctx: Partial<RunContext>): Promise<ToolDefinition[]>;
  execute(def: ToolDefinition, args: JsonObject, ctx: RunContext): Promise<ToolOutput>;
}

/* ---------- LLM port ---------- */
export interface LLMRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  agentId: string;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface LLMReply {
  message: ChatMessage;
  finishReason: 'stop' | 'tool_calls' | 'length' | string;
  usage: TokenUsage | null;
  provider?: string;
  model?: string;
}

export interface LLM {
  complete(req: LLMRequest): Promise<LLMReply>;
}

/* ---------- Policy / safety ---------- */
export type PolicyAction = 'allow' | 'review' | 'deny';

export interface PolicyDecision {
  action: PolicyAction;
  reason: string;
}

export interface PolicyPort {
  check(def: ToolDefinition, args: JsonObject, ctx: RunContext): PolicyDecision;
  /** Wrap untrusted external content so the model treats it as data. */
  wrap(sourceTag: string, text: string): string;
  /** Redact secrets (configured values + token shapes) from any outbound text. */
  scrub(text: string): string;
}

/* ---------- Runs / journal ---------- */
export type RunState =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type EventKind =
  | 'run_started'
  | 'model_step'
  | 'assistant_turn'
  | 'tool_call_started'
  | 'tool_call_finished'
  | 'approval_requested'
  | 'approval_resolved'
  | 'sandbox_created'
  | 'sandbox_lost'
  | 'mcp_unavailable'
  | 'recall_injected'
  | 'compaction'
  | 'artifact'
  | 'usage'
  | 'status'
  | 'error'
  | 'run_finished'
  | 'run_failed'
  | 'run_cancelled';

export interface EventRecord {
  runId: string;
  seq: number;
  kind: EventKind;
  payload: Json;
  ts: string;
}

export interface JournalPort {
  append(runId: string, kind: EventKind, payload: Json): Promise<EventRecord>;
  afterSeq(runId: string, afterSeq: number, limit?: number): Promise<EventRecord[]>;
}

export interface SessionRow {
  id: string;
  userId: string;
  profile: string;
  sandboxId: string | null;
  createdAt: string;
  lastActiveAt: string;
}

export interface RunRow {
  id: string;
  sessionId: string;
  userId: string;
  profile: string;
  state: RunState;
  input: string;
  /** persistent ground-rules for this run's session (repo conventions, citation format, …) */
  context: string | null;
  result: string | null;
  error: string | null;
  iterations: number;
  gatewayCalls: number;
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ToolCallAuditRow {
  id: string;
  runId: string;
  toolCallId: string;
  source: string;
  name: string;
  args: JsonObject;
  ok: boolean;
  resultExcerpt: string;
  policyAction: PolicyAction;
  durationMs: number;
  createdAt: string;
}

export interface ArtifactRow {
  id: string;
  runId: string;
  name: string;
  sandboxPath: string;
  size: number | null;
  createdAt: string;
}

export interface ApprovalRow {
  id: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  args: JsonObject;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decidedBy: string | null;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface StorePort extends JournalPort {
  /* sessions */
  createSession(input: { id: string; userId: string; profile: string }): Promise<SessionRow>;
  getSession(id: string, userId: string): Promise<SessionRow | null>;
  listSessions(userId: string): Promise<SessionRow[]>;
  setSessionSandbox(sessionId: string, sandboxId: string | null): Promise<void>;
  touchSession(sessionId: string): Promise<void>;
  /* runs */
  createRun(input: {
    id: string;
    sessionId: string;
    userId: string;
    profile: string;
    state: RunState;
    input: string;
    context?: string | null;
  }): Promise<RunRow>;
  getRun(id: string): Promise<RunRow | null>;
  listRuns(sessionId: string, limit?: number): Promise<RunRow[]>;
  updateRun(id: string, patch: Partial<RunRow>): Promise<void>;
  markStaleActiveInterrupted(): Promise<RunRow[]>;
  /* audit + artifacts + approvals */
  recordToolCall(row: Omit<ToolCallAuditRow, 'id' | 'createdAt'>): Promise<void>;
  listToolCalls(runId: string): Promise<ToolCallAuditRow[]>;
  addArtifact(row: Omit<ArtifactRow, 'id' | 'createdAt'>): Promise<ArtifactRow>;
  getArtifact(runId: string, name: string): Promise<ArtifactRow | null>;
  upsertApproval(row: Omit<ApprovalRow, 'createdAt' | 'decidedAt'>): Promise<void>;
  decideApproval(id: string, status: 'approved' | 'denied', decidedBy: string, note: string | null): Promise<ApprovalRow | null>;
  pendingApproval(runId: string, toolCallId: string): Promise<ApprovalRow | null>;
  /* quotas */
  addSandboxMinutes(userId: string, minutes: number): Promise<void>;
  sandboxMinutesToday(userId: string): Promise<number>;
  /* api keys */
  storeApiKey(hash: string, userId: string, label: string, profile: string): Promise<void>;
  lookupApiKey(hash: string): Promise<{ userId: string; profile: string; revoked: boolean } | null>;
}

/* ---------- Sandbox ---------- */
export interface SandboxHandle {
  exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  writeFile(path: string, data: string): Promise<void>;
  readFileBase64(path: string): Promise<string>;
  getFileSize(path: string): Promise<number | null>;
  extendTtl(ms: number): Promise<void>;
  kill(): Promise<void>;
  sandboxId: string;
}

export interface SandboxPort {
  available(): boolean;
  ensureHandle(sessionId: string): Promise<{ handle: SandboxHandle; created: boolean }>;
  forget(sessionId: string): Promise<void>;
  shutdownAll(): Promise<void>;
}

/* ---------- Skills ---------- */
export interface SkillMeta {
  id: string;
  path: string;
  category: string;
  title: string;
  purpose: string;
  priority: string;
  triggers: string[];
}

export interface SkillsPort {
  ready(): boolean;
  list(): Promise<SkillMeta[]>;
  manifestText(): Promise<string>;
  /** null when path not found / outside the tree */
  read(relPath: string): Promise<string | null>;
  sync(force?: boolean): Promise<{ files: number; source: string }>;
}

/* ---------- Durable memory (gateway-side) ---------- */
export interface MemoryPort {
  recall(ctx: { agentId: string; sessionId: string }): Promise<string>;
  writeback(ctx: {
    agentId: string;
    sessionId: string;
    gist: string;
    preference?: string | null;
  }): Promise<void>;
}

/* ---------- Profiles ---------- */
export interface ProfileConfig {
  name: string;
  route: string;
  loopMaxIterations: number;
  wallclockMs: number;
  contextTokenBudget: number;
  toolAllow: string[];
  autoApprove: string[];
  review: string[];
  deny: string[];
  sandboxEnabled: boolean;
  memoryWriteback: boolean;
  temperature: number;
}

/* ---------- Misc shared ---------- */
export interface AuthIdentity {
  userId: string;
  profile: string;
  admin: boolean;
}
