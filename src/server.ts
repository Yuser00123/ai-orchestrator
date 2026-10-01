import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import type { Orchestrator } from './app.js';
import { createOrchestrator } from './app.js';
import type { AuthIdentity } from './contracts/index.js';
import { AuthError, RateLimitedError, ValidationError, toPublicError } from './core/errors.js';
import { uuid } from './core/util.js';

declare module 'fastify' {
  interface FastifyRequest {
    identity?: AuthIdentity;
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

/* ---------------- app factory (testable) ---------------- */

export function buildServer(orch: Orchestrator): FastifyInstance {
  const app = Fastify({
    logger: { level: orch.cfg.env.LOG_LEVEL, redact: ['req.headers.authorization'] },
    bodyLimit: 1_500_000,
    trustProxy: true,
  });

  const origins = orch.cfg.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  void app.register(cors, {
    origin: origins.includes('*') ? true : origins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'last-event-id'],
    exposedHeaders: ['retry-after', 'x-request-id'],
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err, req, reply) => {
    const pub = toPublicError(err);
    req.log.warn({ err: pub.message, code: pub.code }, 'request error');
    void reply.status(pub.status).send({ error: { message: orch.policy.scrub(pub.message).slice(0, 500), type: pub.code } });
  });

  /* ----- auth ----- */
  const authenticate = async (req: FastifyRequest): Promise<AuthIdentity> => {
    const identity = await orch.auth.authenticate(req.headers.authorization);
    req.identity = identity;
    const limit = orch.limiter.check(identity.userId, 'api');
    if (!limit.ok) throw new RateLimitedError(limit.retryAfterSec);
    return identity;
  };

  /* ---------------- public ---------------- */
  app.get('/health', async () => ({ status: 'ok', service: 'agent-orchestrator', uptime_s: Math.round(process.uptime()) }));
  app.post('/wake', async () => ({ ok: true }));

  app.get('/ready', async (req, reply) => {
    const ident = await orch.auth.authenticate(req.headers.authorization);
    orch.auth.requireAdmin(ident);
    const r = await orch.ready();
    const down = r.gateway === 'unreachable' || String(r.store).includes('DOWN');
    return reply.status(down ? 503 : 200).send(r);
  });

  /* ---------------- runs ---------------- */
  app.post('/v1/runs', { preHandler: authenticate }, async (req, reply) => {
    const ident = req.identity!;
    const Body = z.object({
      message: z.string().trim().min(1).max(32_000),
      session_id: z.string().regex(ID_RE).optional(),
      profile: z.string().min(1).max(40).optional(),
      /** persistent ground rules for the session (repo conventions, output format, paths…) */
      context: z.string().trim().max(4_000).optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(`invalid request: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);

    const requested = parsed.data.profile ?? ident.profile;
    if (!orch.cfg.profiles.has(requested)) throw new ValidationError(`unknown profile "${requested}"`);
    if (!ident.admin && requested !== ident.profile) throw new ValidationError('this API key may only use its default profile');

    const rate = orch.limiter.check(ident.userId, 'run');
    if (!rate.ok) throw new RateLimitedError(rate.retryAfterSec, 'run creation rate limited');

    const sessionId = parsed.data.session_id ?? `sess_${uuid().slice(0, 13)}`;
    const session = await orch.store.createSession({ id: sessionId, userId: ident.userId, profile: requested });
    const runId = `run_${uuid().slice(0, 13)}`;
    const run = await orch.store.createRun({ id: runId, sessionId, userId: ident.userId, profile: requested, state: 'queued', input: parsed.data.message, context: parsed.data.context ?? null });
    void orch.store.touchSession(sessionId);

    void orch.engine.start({ run, session, userMessage: parsed.data.message }).catch((err) => {
      req.log.error({ err: err instanceof Error ? err.message : String(err) }, 'engine start rejection escaped');
    });

    return reply.status(202).send({ run_id: runId, session_id: sessionId, state: 'queued', events_url: `/v1/runs/${runId}/events` });
  });

  const ownedRun = async (req: FastifyRequest, runId: string) => {
    const ident = req.identity!;
    const run = await orch.store.getRun(runId);
    if (!run || (run.userId !== ident.userId && !ident.admin)) throw new (await import('./core/errors.js')).OrchestratorError('not_found', 'run not found', 404);
    return run;
  };

  app.get('/v1/runs/:id', { preHandler: authenticate }, async (req) => {
    const run = await ownedRun(req, (req.params as { id: string }).id);
    return { ...run, output: run.result };
  });

  app.post('/v1/runs/:id/cancel', { preHandler: authenticate }, async (req) => {
    const run = await ownedRun(req, (req.params as { id: string }).id);
    const cancelled = orch.engine.cancel(run.id);
    if (!cancelled && ['completed', 'failed', 'cancelled'].includes(run.state)) return { run_id: run.id, state: run.state, note: 'already terminal' };
    if (!cancelled) await orch.store.updateRun(run.id, { state: 'cancelled', error: 'cancelled (not active on this instance)', finishedAt: new Date().toISOString() });
    return { run_id: run.id, cancelled: true };
  });

  app.post('/v1/runs/:id/approve', { preHandler: authenticate }, async (req) => {
    const run = await ownedRun(req, (req.params as { id: string }).id);
    const Body = z.object({ tool_call_id: z.string().min(1).max(120), decision: z.enum(['approved', 'denied']), note: z.string().max(500).optional() });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('approve requires {tool_call_id, decision: approved|denied}');
    const ok = orch.engine.decide(run.id, parsed.data.tool_call_id, parsed.data.decision);
    if (!ok) throw new ValidationError('no pending approval for that tool_call_id on this run (expired, decided, or run not active)');
    return { run_id: run.id, tool_call_id: parsed.data.tool_call_id, decision: parsed.data.decision };
  });

  app.get('/v1/runs/:id/events', { preHandler: authenticate }, async (req, reply) => {
    const run = await ownedRun(req, (req.params as { id: string }).id);
    const asJson = req.raw.url?.includes('format=json');
    const lastHeader = req.headers['last-event-id'];
    const after = Number(
      (asJson && new URL(req.raw.url!, 'http://x').searchParams.get('after')) ||
        (typeof lastHeader === 'string' ? lastHeader : '0') ||
        '0',
    );
    const from = Number.isFinite(after) && after >= 0 ? Math.floor(after) : 0;

    if (asJson) return { run_id: run.id, events: await orch.store.afterSeq(run.id, from, 1000) };

    /* SSE */
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let cursor = from;
    let closed = false;
    let tick: ReturnType<typeof setInterval> | undefined;
    let beat: ReturnType<typeof setInterval> | undefined;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (tick) clearInterval(tick);
      if (beat) clearInterval(beat);
      raw.end();
    };
    req.raw.on('close', close);

    const pump = async (): Promise<void> => {
      const events = await orch.store.afterSeq(run.id, cursor, 200);
      for (const ev of events) {
        cursor = ev.seq;
        raw.write(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      const fresh = await orch.store.getRun(run.id);
      if (fresh && ['completed', 'failed', 'cancelled', 'interrupted'].includes(fresh.state)) {
        const rest = await orch.store.afterSeq(run.id, cursor, 50);
        for (const ev of rest) {
          cursor = ev.seq;
          raw.write(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
        }
        close();
      }
    };

    await pump().catch(() => close());
    tick = setInterval(() => void pump().catch(() => close()), 500);
    beat = setInterval(() => {
      if (!closed) raw.write(': ka\n\n');
    }, 15_000);
  });

  app.get('/v1/runs/:id/tool-calls', { preHandler: authenticate }, async (req) => {
    const run = await ownedRun(req, (req.params as { id: string }).id);
    return { run_id: run.id, calls: await orch.store.listToolCalls(run.id) };
  });

  app.get('/v1/runs/:id/artifacts/:name', { preHandler: authenticate }, async (req, reply) => {
    const params = req.params as { id: string; name: string };
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(params.name)) throw new ValidationError('invalid artifact name');
    const run = await ownedRun(req, params.id);
    const artifact = await orch.store.getArtifact(run.id, params.name);
    if (!artifact) throw new (await import('./core/errors.js')).OrchestratorError('not_found', 'artifact not found', 404);
    if (!orch.sandbox.available()) throw new ValidationError('sandbox provider unavailable — artifact cannot be read');

    const session = await orch.store.getSession(run.sessionId, run.userId);
    if (!session) throw new (await import('./core/errors.js')).OrchestratorError('not_found', 'session not found', 404);
    const { handle } = await orch.sandbox.ensureHandle(session.id);
    const size = await handle.getFileSize(artifact.sandboxPath);
    if (size === null) throw new (await import('./core/errors.js')).OrchestratorError('gone', 'artifact file no longer exists in the sandbox (sandbox expired?)', 410);
    if (size > orch.cfg.env.ARTIFACT_MAX_BYTES) throw new ValidationError(`artifact too large (${size} > ${orch.cfg.env.ARTIFACT_MAX_BYTES} bytes)`);
    const b64 = await handle.readFileBase64(artifact.sandboxPath);
    const buf = Buffer.from(b64, 'base64');
    reply.header('content-type', mimeFor(params.name));
    reply.header('content-disposition', `attachment; filename="${params.name.replace(/"/g, '')}"`);
    return reply.send(buf);
  });

  /* ---------------- sessions / capability views ---------------- */
  app.get('/v1/sessions', { preHandler: authenticate }, async (req) => {
    const ident = req.identity!;
    return { sessions: await orch.store.listSessions(ident.userId) };
  });

  app.get('/v1/sessions/:id', { preHandler: authenticate }, async (req) => {
    const ident = req.identity!;
    const session = await orch.store.getSession((req.params as { id: string }).id, ident.userId);
    if (!session) throw new (await import('./core/errors.js')).OrchestratorError('not_found', 'session not found', 404);
    const runs = await orch.store.listRuns(session.id, 50);
    return { session, runs: runs.map((r) => ({ ...r, input: r.input.slice(0, 400) })) };
  });

  app.get('/v1/skills', { preHandler: authenticate }, async () => ({ ready: orch.skills.ready(), skills: await orch.skills.list() }));
  app.get('/v1/tools', { preHandler: authenticate }, async () => ({ tools: await orch.registry.listAllForAdmin() }));

  /* ---------------- admin ---------------- */
  const adminOnly = async (req: FastifyRequest): Promise<void> => {
    const ident = await authenticate(req);
    orch.auth.requireAdmin(ident);
  };

  app.post('/admin/keys', { preHandler: adminOnly }, async (req) => {
    const Body = z.object({ user_id: z.string().regex(ID_RE), label: z.string().min(1).max(120), profile: z.string().optional() });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('issue key needs {user_id, label, profile?}');
    const profile = parsed.data.profile ?? orch.cfg.defaultProfile;
    if (!orch.cfg.profiles.has(profile)) throw new ValidationError(`unknown profile "${profile}"`);
    const token = await orch.auth.issueKey(parsed.data.user_id, parsed.data.label, profile);
    return { token, note: 'store now — it is not retrievable later', profile };
  });

  app.post('/admin/skills/sync', { preHandler: adminOnly }, async () => await orch.skills.sync(true));
  app.post('/admin/mcp/refresh', { preHandler: adminOnly }, async () => {
    await orch.mcp?.refresh();
    return { refreshed: true, health: (await orch.mcp?.health()) ?? [] };
  });

  return app;
}

const MIME: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.py': 'text/x-python; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
};

export function mimeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && MIME[name.slice(dot).toLowerCase()]) || 'application/octet-stream';
}

/* ---------------- bootstrap ---------------- */

async function main(): Promise<void> {
  const orch = await createOrchestrator();
  const app = buildServer(orch);
  await app.listen({ port: orch.cfg.env.PORT, host: orch.cfg.env.HOST });
  app.log.info(`agent-orchestrator listening on ${orch.cfg.env.HOST}:${orch.cfg.env.PORT} (llm=${orch.cfg.env.LLM_MODE}, store=${orch.cfg.env.DATABASE_URL ? 'postgres' : 'memory'})`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'graceful shutdown: closing http, killing sandboxes');
    const active = orch.engine.activeRunIds();
    for (const id of active) orch.engine.cancel(id);
    await app.close();
    await Promise.race([orch.shutdown(), new Promise((r) => setTimeout(r, 10_000))]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

import { pathToFileURL } from 'node:url';
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('agent-orchestrator failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
