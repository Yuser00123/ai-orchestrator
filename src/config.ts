import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Json, ProfileConfig } from './contracts/index.js';

/* ---------------- env ---------------- */

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8788),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    GATEWAY_BASE_URL: z.string().url().default('http://localhost:8787'),
    GATEWAY_API_KEY: z.string().min(16).optional(),
    GATEWAY_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180_000).default(120_000),
    GATEWAY_MAX_RETRIES: z.coerce.number().int().min(0).max(6).default(3),
    GATEWAY_RETRY_BASE_MS: z.coerce.number().int().min(100).default(700),
    GATEWAY_MAX_CALLS_PER_RUN: z.coerce.number().int().min(2).max(60).default(25),

    /** development/testing only: deterministic mock LLM, no gateway calls */
    LLM_MODE: z.enum(['gateway', 'mock']).default('gateway'),

    ORCH_MASTER_KEY: z.string().min(16).optional(),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),

    E2B_API_KEY: z.string().optional(),
    E2B_TEMPLATE: z.string().default('base'),
    E2B_IDLE_TTL_MS: z.coerce.number().int().min(30_000).default(600_000),
    E2B_MAX_SESSION_MS: z.coerce.number().int().min(60_000).default(3_300_000),
    E2B_EXEC_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(300_000),
    SANDBOX_MINUTES_PER_USER_DAY: z.coerce.number().int().min(1).default(30),

    CORS_ORIGINS: z.string().default('*'),
    RUN_RATE_PER_MIN: z.coerce.number().int().min(1).default(10),
    API_RATE_PER_MIN: z.coerce.number().int().min(10).default(120),
    APPROVAL_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(900_000),
    TOOL_RESULT_MAX_BYTES: z.coerce.number().int().min(2_048).max(262_144).default(12_288),
    ARTIFACT_MAX_BYTES: z.coerce.number().int().min(1024).default(10_485_760),

    CONFIG_DIR: z.string().default('./config'),
    DATA_DIR: z.string().default('./data'),
    DATABASE_URL: z.string().optional(),
  })
  .refine((v) => v.LLM_MODE === 'mock' || !!v.GATEWAY_API_KEY, {
    message: 'GATEWAY_API_KEY is required unless LLM_MODE=mock',
    path: ['GATEWAY_API_KEY'],
  })
  .refine((v) => v.NODE_ENV !== 'production' || !!v.ORCH_MASTER_KEY, {
    message: 'ORCH_MASTER_KEY (>=16 chars) is required in production',
    path: ['ORCH_MASTER_KEY'],
  });

export type Env = z.infer<typeof EnvSchema>;

/* ---------------- file configs ---------------- */

const ProfileSchema = z.object({
  route: z.string().min(1),
  loopMaxIterations: z.number().int().min(1).max(40).default(12),
  wallclockMs: z.number().int().min(30_000).max(1_800_000).default(900_000),
  contextTokenBudget: z.number().int().min(2_000).max(60_000).default(11_000),
  toolAllow: z.array(z.string()).default(['orch.*']),
  autoApprove: z.array(z.string()).default([]),
  review: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  sandboxEnabled: z.boolean().default(false),
  memoryWriteback: z.boolean().default(true),
  temperature: z.number().min(0).max(2).default(0.2),
});

const ProfilesFileSchema = z.object({
  default: z.string().default('code'),
  profiles: z.record(ProfileSchema),
});

const McpServerSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,30}$/),
  transport: z.enum(['http', 'stdio']).default('http'),
  url: z.string().optional(),
  urlEnv: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  /** header name -> value template with $ENVVAR substitution */
  headers: z.record(z.string()).default({}),
  /** query param name -> $ENVVAR token */
  queryFromEnv: z.record(z.string()).default({}),
  allowedTools: z.array(z.string()).optional(),
  deniedTools: z.array(z.string()).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(45_000),
  listTtlMs: z.number().int().min(10_000).default(600_000),
  enabled: z.boolean().default(true),
});

const McpFileSchema = z.object({ servers: z.array(McpServerSchema).default([]) });

const SkillsFileSchema = z.object({
  dir: z.string().optional(),
  repo: z.string().default('Yuser00123/agent-skills'),
  ref: z.string().default('main'),
  tokenEnv: z.string().default('GITHUB_TOKEN'),
  cacheDir: z.string().default('./data/skills'),
  syncOnBoot: z.boolean().default(true),
  maxFileBytes: z.number().int().min(1_024).default(65_536),
});

/* ---------------- assembled config ---------------- */

export interface McpServerConfig extends z.infer<typeof McpServerSchema> {
  resolvedUrl: string | null;
  resolvedHeaders: Record<string, string>;
}

export interface AppConfig {
  env: Env;
  isProduction: boolean;
  defaultProfile: string;
  profiles: Map<string, ProfileConfig>;
  mcpServers: McpServerConfig[];
  skills: z.infer<typeof SkillsFileSchema>;
  /** every configured secret value — scrubbed out of all tool output */
  secretsToScrub: string[];
}

function loadJson(file: string, fallback: Json): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function substEnv(template: string): string {
  return template.replace(/\$([A-Z][A-Z0-9_]*)/g, (_, name: string) => process.env[name] ?? '');
}

export function loadConfig(over?: Partial<Env>): AppConfig {
  requireDotEnv();
  const env = EnvSchema.parse({ ...process.env, ...over });

  const cfgDir = path.resolve(env.CONFIG_DIR);
  const profilesParsed = ProfilesFileSchema.safeParse(
    loadJson(path.join(cfgDir, 'profiles.json'), { default: 'code', profiles: {} }),
  );
  if (!profilesParsed.success) {
    throw new Error(`config/profiles.json invalid: ${profilesParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  if (profilesParsed.data.profiles[profilesParsed.data.default] === undefined) {
    throw new Error(`config/profiles.json: default profile "${profilesParsed.data.default}" not defined`);
  }

  const profiles = new Map<string, ProfileConfig>();
  for (const [name, p] of Object.entries(profilesParsed.data.profiles)) {
    const parsed = ProfileSchema.parse(p);
    profiles.set(name, {
      name,
      route: parsed.route,
      loopMaxIterations: parsed.loopMaxIterations,
      wallclockMs: parsed.wallclockMs,
      contextTokenBudget: parsed.contextTokenBudget,
      toolAllow: parsed.toolAllow,
      autoApprove: parsed.autoApprove,
      review: parsed.review,
      deny: parsed.deny,
      sandboxEnabled: parsed.sandboxEnabled,
      memoryWriteback: parsed.memoryWriteback,
      temperature: parsed.temperature,
    });
  }

  const mcpParsed = McpFileSchema.safeParse(loadJson(path.join(cfgDir, 'mcp.json'), { servers: [] }));
  if (!mcpParsed.success) throw new Error('config/mcp.json invalid');
  const seen = new Set<string>();
  const mcpServers: McpServerConfig[] = mcpParsed.data.servers.map((s) => {
    if (seen.has(s.id)) throw new Error(`config/mcp.json: duplicate server id "${s.id}"`);
    seen.add(s.id);
    const rawUrl = s.url ?? (s.urlEnv ? process.env[s.urlEnv] : undefined);
    const headers: Record<string, string> = {};
    for (const [h, v] of Object.entries(s.headers)) {
      const val = substEnv(v).trim();
      if (val) headers[h] = val;
      else if (/\$[A-Z]/.test(v)) return { ...s, resolvedUrl: rawUrl ?? null, resolvedHeaders: { ...headers, __incomplete: '1' } as never };
    }
    return { ...s, resolvedUrl: rawUrl ?? null, resolvedHeaders: headers };
  });

  const skillsParsed = SkillsFileSchema.safeParse(loadJson(path.join(cfgDir, 'skills.json'), {}));
  if (!skillsParsed.success) throw new Error('config/skills.json invalid');

  const secretsToScrub = [
    env.GATEWAY_API_KEY,
    env.ORCH_MASTER_KEY,
    env.E2B_API_KEY,
    env.DATABASE_URL?.match(/:[^:@/]+@/)?.[0]?.slice(1, -1),
    ...mcpServers.flatMap((s) => Object.values(s.resolvedHeaders)),
    ...(mcpServers.flatMap((s) => Object.values(s.queryFromEnv)).map((e) => process.env[e])),
  ].filter((x): x is string => typeof x === 'string' && x.length >= 8);

  return {
    env,
    isProduction: env.NODE_ENV === 'production',
    defaultProfile: profilesParsed.data.default,
    profiles,
    mcpServers,
    skills: skillsParsed.data,
    secretsToScrub,
  };
}

let dotenvLoaded = false;
function requireDotEnv(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  try {
    // optional dependency behavior: load .env if present without hard-importing dotenv at module eval
    const txt = readFileSync(path.resolve(process.cwd(), '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no .env file — fine */
  }
}
