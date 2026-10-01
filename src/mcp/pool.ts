import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JsonSchema, JsonObject, RunContext, ToolDefinition, ToolOutput, ToolSource } from '../contracts/index.js';
import { sha256Hex, truncateText, withTimeout } from '../core/util.js';
import { matchAny } from '../core/util.js';
import type { McpServerConfig } from '../config.js';

export interface McpServerHealth {
  id: string;
  state: 'ok' | 'degraded' | 'disabled';
  tools: number;
  lastError: string | null;
  connectedAt: string | null;
}

interface ServerState {
  cfg: McpServerConfig;
  client: Client | null;
  connecting: Promise<Client> | null;
  defs: ToolDefinition[];
  nameMap: Map<string, { orig: string }>;
  expiresAt: number;
  lastError: string | null;
  connectedAt: string | null;
}

/**
 * McpPool — one ToolSource over N servers (§7).
 * Lazy connect, TTL-cached tool lists, per-server allow/deny, timeouts,
 * and graceful degradation: a broken server loses its tools for the run,
 * it never fails the run.
 */
export class McpPool implements ToolSource {
  readonly id = 'mcp';
  readonly kind = 'mcp' as const;
  private states = new Map<string, ServerState>();

  constructor(servers: McpServerConfig[]) {
    for (const cfg of servers) {
      this.states.set(cfg.id, {
        cfg,
        client: null,
        connecting: null,
        defs: [],
        nameMap: new Map(),
        expiresAt: 0,
        lastError: null,
        connectedAt: null,
      });
    }
  }

  private usable(s: ServerState): boolean {
    return s.cfg.enabled && (s.cfg.transport === 'stdio' ? Boolean(s.cfg.command) : Boolean(s.cfg.resolvedUrl) && !s.cfg.resolvedHeaders.__incomplete);
  }

  async enabled(): Promise<boolean> {
    return [...this.states.values()].some((s) => this.usable(s));
  }

  async listTools(_ctx: Partial<RunContext>): Promise<ToolDefinition[]> {
    const out: ToolDefinition[] = [];
    for (const s of this.states.values()) {
      if (!this.usable(s)) continue;
      if (Date.now() < s.expiresAt) {
        out.push(...s.defs);
        continue;
      }
      try {
        await this.refreshServer(s);
        out.push(...s.defs);
      } catch (err) {
        s.lastError = err instanceof Error ? err.message : String(err);
        s.defs = [];
        s.nameMap.clear();
        s.expiresAt = Date.now() + 30_000; // back off refresh attempts
      }
    }
    return out;
  }

  async execute(def: ToolDefinition, args: JsonObject, ctx: RunContext): Promise<ToolOutput> {
    const serverId = def.sourceId.slice('mcp:'.length);
    const s = this.states.get(serverId);
    if (!s) return { ok: false, content: `mcp server "${serverId}" is not configured` };
    const orig = s.nameMap.get(def.name)?.orig ?? stripPrefix(def.name, serverId);
    try {
      const client = await this.ensureConnected(s);
      const result = await withTimeout(
        client.callTool({ name: orig, arguments: args }, undefined, { timeout: s.cfg.timeoutMs, signal: ctx.signal }),
        s.cfg.timeoutMs + 5_000,
        `mcp call ${def.name}`,
      );
      return mcpResultToOutput(result);
    } catch (err) {
      s.client = null;
      s.connecting = null;
      s.lastError = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `MCP server "${serverId}" failed: ${s.lastError.slice(0, 300)}` };
    }
  }

  async health(): Promise<McpServerHealth[]> {
    return [...this.states.values()].map((s) => ({
      id: s.cfg.id,
      state: !this.usable(s) ? 'disabled' : s.client || s.defs.length > 0 ? 'ok' : 'degraded',
      tools: s.defs.length,
      lastError: s.lastError,
      connectedAt: s.connectedAt,
    }));
  }

  async refresh(): Promise<void> {
    for (const s of this.states.values()) s.expiresAt = 0;
  }

  async shutdown(): Promise<void> {
    for (const s of this.states.values()) {
      await s.client?.close().catch(() => undefined);
      s.client = null;
    }
  }

  /* ---------------- internals ---------------- */

  private async refreshServer(s: ServerState): Promise<void> {
    const client = await this.ensureConnected(s);
    const { tools } = await withTimeout(client.listTools(), s.cfg.timeoutMs, `mcp listTools ${s.cfg.id}`);
    const defs: ToolDefinition[] = [];
    const nameMap = new Map<string, { orig: string }>();
    for (const t of tools) {
      if (!t?.name) continue;
      if (s.cfg.allowedTools && !matchAny(s.cfg.allowedTools, t.name)) continue;
      if (s.cfg.deniedTools && matchAny(s.cfg.deniedTools, t.name)) continue;
      const ns = namespaced(s.cfg.id, t.name);
      defs.push({
        name: ns,
        description: `[mcp:${s.cfg.id}] ${(t.description ?? 'no description').slice(0, 600)}`,
        parameters: (t.inputSchema as JsonSchema) ?? { type: 'object', properties: {} },
        sourceId: `mcp:${s.cfg.id}`,
        external: true,
        mutating: !/^(get|list|search|read|fetch|view|check|analyze|describe)/i.test(t.name),
        timeoutMs: s.cfg.timeoutMs,
        parallelSafe: true,
      });
      nameMap.set(ns, { orig: t.name });
    }
    s.defs = defs;
    s.nameMap = nameMap;
    s.expiresAt = Date.now() + s.cfg.listTtlMs;
    s.lastError = null;
  }

  private async ensureConnected(s: ServerState): Promise<Client> {
    if (s.client) return s.client;
    if (s.connecting) return s.connecting;
    s.connecting = this.connect(s).then(
      (c) => {
        s.connecting = null;
        return c;
      },
      (err) => {
        s.connecting = null;
        throw err;
      },
    );
    return s.connecting;
  }

  private async connect(s: ServerState): Promise<Client> {
    const client = new Client({ name: 'agent-orchestrator', version: '0.1.0' });
    if (s.cfg.transport === 'stdio') {
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
      const transport = new StdioClientTransport({ command: s.cfg.command ?? 'npx', args: s.cfg.args, env: env as Record<string, never> });
      await withTimeout(client.connect(transport), 30_000, `mcp stdio connect ${s.cfg.id}`);
    } else {
      const url = new URL(s.cfg.resolvedUrl!);
      for (const [param, envName] of Object.entries(s.cfg.queryFromEnv)) {
        const val = process.env[envName];
        if (val) url.searchParams.set(param, val);
      }
      const headers: Record<string, string> = {};
      for (const [h, v] of Object.entries(s.cfg.resolvedHeaders)) if (h !== '__incomplete') headers[h] = v;
      const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
      await withTimeout(client.connect(transport), 30_000, `mcp http connect ${s.cfg.id}`);
    }
    s.client = client;
    s.connectedAt = new Date().toISOString();
    return client;
  }
}

/* helpers */
const stripPrefix = (ns: string, serverId: string): string => ns.replace(new RegExp(`^mcp__${serverId}__`), '');

function namespaced(serverId: string, toolName: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
  let name = `mcp__${safe(serverId)}__${safe(toolName)}`;
  if (name.length > 64) name = `${name.slice(0, 55)}_${sha256Hex(name).slice(0, 8)}`;
  return name;
}

function mcpResultToOutput(result: unknown): ToolOutput {
  const r = result as {
    content?: { type: string; text?: string; data?: string; mimeType?: string }[];
    structuredContent?: JsonObject;
    isError?: boolean;
  };
  const parts: string[] = [];
  for (const block of r?.content ?? []) {
    if (block.type === 'text' && block.text) parts.push(block.text);
    else if (block.type === 'image') parts.push(`[image omitted: ${block.mimeType ?? 'unknown'}, ${(block.data ?? '').length} b64 bytes]`);
    else if (block.type === 'resource') parts.push(`[embedded resource: ${JSON.stringify(block).slice(0, 500)}]`);
    else parts.push(JSON.stringify(block)?.slice(0, 1000) ?? '');
  }
  if (parts.length === 0 && r?.structuredContent) parts.push(JSON.stringify(r.structuredContent));
  const text = parts.join('\n') || '(empty result)';
  return { ok: !r?.isError, content: truncateText(text, 200_000).text };
}
