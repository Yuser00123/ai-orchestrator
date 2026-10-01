import path from 'node:path';
import type { LLM, MemoryPort, StorePort, SandboxPort, SkillsPort } from './contracts/index.js';
import { loadConfig, type AppConfig } from './config.js';
import { Policy } from './security/policy.js';
import { makeScrubber } from './security/scrub.js';
import { RateLimiter } from './security/ratelimit.js';
import { GatewayClient, MockLlm } from './gateway/client.js';
import { createBuiltinSource } from './tools/builtin.js';
import { ToolRegistry } from './tools/registry.js';
import { SkillsStore } from './skills/store.js';
import { createSandboxSource, E2bSandboxManager } from './sandbox/e2b.js';
import { McpPool } from './mcp/pool.js';
import { MemoryStore } from './runs/store-memory.js';
import { PgStore } from './runs/store-pg.js';
import { GatewayMemory, NullMemory } from './runs/memory.js';
import { RunEngine } from './runs/engine.js';
import { KeyAuth } from './auth/keys.js';
import { uuid } from './core/util.js';

/**
 * Composition root (§11.1-5). Every module is constructed here, behind its
 * contract interface; routes/loop depend only on `Orchestrator`'s fields.
 */
export interface Orchestrator {
  cfg: AppConfig;
  store: StorePort;
  pg?: PgStore;
  llm: LLM;
  gateway?: GatewayClient;
  policy: Policy;
  registry: ToolRegistry;
  skills: SkillsPort;
  sandbox: SandboxPort;
  mcp: McpPool | null;
  memory: MemoryPort;
  engine: RunEngine;
  auth: KeyAuth;
  limiter: RateLimiter;
  shutdown(): Promise<void>;
  ready(): Promise<Record<string, unknown>>;
}

export interface BootOverrides {
  config?: AppConfig;
  llm?: LLM;
  store?: StorePort;
  skills?: SkillsPort;
  sandbox?: SandboxPort;
}

export async function createOrchestrator(over: BootOverrides = {}): Promise<Orchestrator> {
  const cfg = over.config ?? loadConfig();
  const scrub = makeScrubber(cfg.secretsToScrub);

  /* store */
  let store: StorePort;
  let pg: PgStore | undefined;
  if (over.store) {
    store = over.store;
  } else if (cfg.env.DATABASE_URL) {
    pg = new PgStore(cfg.env.DATABASE_URL, cfg.env.DB_POOL_MAX);
    await pg.migrate();
    store = pg;
  } else {
    process.emitWarning('DATABASE_URL not set — using in-memory store (state lost on restart)');
    store = new MemoryStore();
  }

  /* LLM port */
  let gateway: GatewayClient | undefined;
  let llm: LLM;
  if (over.llm) {
    llm = over.llm;
  } else if (cfg.env.LLM_MODE === 'mock') {
    if (cfg.isProduction) throw new Error('LLM_MODE=mock is not allowed in production');
    llm = new MockLlm();
  } else {
    gateway = new GatewayClient({
      baseUrl: cfg.env.GATEWAY_BASE_URL,
      apiKey: cfg.env.GATEWAY_API_KEY!,
      timeoutMs: cfg.env.GATEWAY_REQUEST_TIMEOUT_MS,
      maxRetries: cfg.env.GATEWAY_MAX_RETRIES,
      retryBaseMs: cfg.env.GATEWAY_RETRY_BASE_MS,
    });
    llm = gateway;
  }

  /* safety */
  const policy = new Policy({ scrub });
  const limiter = new RateLimiter(cfg.env.API_RATE_PER_MIN, cfg.env.RUN_RATE_PER_MIN);

  /* skills */
  const skills: SkillsPort =
    over.skills ??
    new SkillsStore({ ...cfg.skills, cacheDir: path.resolve(cfg.env.DATA_DIR, 'skills') });
  if (!over.skills && cfg.skills.syncOnBoot) {
    void skills.sync().catch((err) => process.emitWarning(`skills boot-sync failed (continuing without): ${err?.message ?? err}`));
  }

  /* sandbox */
  const sandbox: SandboxPort =
    over.sandbox ??
    new E2bSandboxManager({
      apiKey: cfg.env.E2B_API_KEY,
      template: cfg.env.E2B_TEMPLATE,
      idleTtlMs: cfg.env.E2B_IDLE_TTL_MS,
      maxSessionMs: cfg.env.E2B_MAX_SESSION_MS,
      execTimeoutMs: cfg.env.E2B_EXEC_TIMEOUT_MS,
    });

  /* memory port */
  const memory: MemoryPort = gateway ? new GatewayMemory(gateway, true) : new NullMemory();

  /* tool plane */
  const registry = new ToolRegistry({ policy, store, toolResultMaxBytes: cfg.env.TOOL_RESULT_MAX_BYTES });
  registry.register(createBuiltinSource({ skills, store, fetchMaxBytes: 1_000_000 }));
  if (sandbox.available()) {
    const sandboxSource = createSandboxSource({
      manager: sandbox,
      execTimeoutMs: cfg.env.E2B_EXEC_TIMEOUT_MS,
      quotaGuard: async (userId) => {
        if (userId === 'master') return;
        const used = await store.sandboxMinutesToday(userId);
        if (used >= cfg.env.SANDBOX_MINUTES_PER_USER_DAY) {
          throw new Error(`daily sandbox quota reached (${used}/${cfg.env.SANDBOX_MINUTES_PER_USER_DAY} min). Ask the user to raise it or continue without code execution.`);
        }
        await store.addSandboxMinutes(userId, cfg.env.E2B_IDLE_TTL_MS / 60_000);
      },
    });
    registry.register(sandboxSource);
  }
  let mcp: McpPool | null = null;
  if (cfg.mcpServers.length > 0) {
    mcp = new McpPool(cfg.mcpServers);
    registry.register(mcp);
  }

  /* engine + auth */
  const engine = new RunEngine({
    llm,
    registry,
    policy,
    store,
    skills,
    memory,
    profiles: cfg.profiles,
    gatewayMaxCallsPerRun: cfg.env.GATEWAY_MAX_CALLS_PER_RUN,
    approvalTimeoutMs: cfg.env.APPROVAL_TIMEOUT_MS,
  });
  const auth = new KeyAuth(store, cfg.env.ORCH_MASTER_KEY);

  const stale = await store.markStaleActiveInterrupted();
  if (stale.length > 0) process.emitWarning(`marked ${stale.length} stale run(s) as interrupted after restart`);

  return {
    cfg,
    store,
    pg,
    llm,
    gateway,
    policy,
    registry,
    skills,
    sandbox,
    mcp,
    memory,
    engine,
    auth,
    limiter,
    async shutdown() {
      await sandbox.shutdownAll().catch(() => undefined);
      await mcp?.shutdown().catch(() => undefined);
      await pg?.close().catch(() => undefined);
    },
    async ready() {
      const storeOk = pg ? await pg.ping() : true;
      const gatewayOk = gateway ? await gateway.health() : cfg.env.LLM_MODE === 'mock';
      const skillsReady = skills.ready();
      const mcpHealth = mcp ? await mcp.health() : [];
      return {
        store: pg ? (storeOk ? 'postgres' : 'postgres:DOWN') : 'memory',
        gateway: gatewayOk ? 'ok' : 'unreachable',
        sandbox: sandbox.available() ? 'e2b-configured' : 'disabled',
        skills: skillsReady ? 'loaded' : 'not-synced',
        mcp: mcpHealth,
        active_runs: engine.activeRunIds().length,
        run_id: uuid(),
      };
    },
  };
}
