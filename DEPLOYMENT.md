# Deployment, Configuration & Operations Guide

Everything below is verified against the code in this repo (`src/config.ts` schemas, `config/*.json`, `src/server.ts` routes).

---

## 1. Complete environment variable reference

### Required for a real deployment

| Var | Default | Constraint | Meaning |
|---|---|---|---|
| `GATEWAY_API_KEY` | — | ≥16 chars; **required unless `LLM_MODE=mock`** | Your gateway's `GATEWAY_API_KEY`. Boot fails without it in gateway mode. |
| `ORCH_MASTER_KEY` | — | ≥16 chars; **required when `NODE_ENV=production`** | Admin Bearer key for this orchestrator (issues client keys, admin endpoints). Anyone holding it = admin. Generate: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`. |
| `NODE_ENV` | `development` | enum | Set `production` on Render — it activates the master-key rule and blocks `LLM_MODE=mock`. |
| `DATABASE_URL` | *(empty → in-memory)* | postgres URL | **Empty = all run state lost on every restart** — fine for first deploy only. Use a Neon pooled URL; schema auto-creates at boot. |

### Gateway connection

| Var | Default | Range | Meaning |
|---|---|---|---|
| `GATEWAY_BASE_URL` | `http://localhost:8787` | url | Your gateway root (e.g. `https://ai-api-unifier.onrender.com`). |
| `GATEWAY_REQUEST_TIMEOUT_MS` | `120000` | 1 s–180 s | Per-attempt timeout. Must exceed the gateway's 90 s provider timeout so one gateway failover chain isn't cut off. |
| `GATEWAY_MAX_RETRIES` | `3` | 0–6 | Retries on transient failures (connect refused, 408/409/425/429/5xx) with exponential backoff. Covers Render warming/restarts. |
| `GATEWAY_RETRY_BASE_MS` | `700` | ≥100 | Backoff base; jitter added. |
| `GATEWAY_MAX_CALLS_PER_RUN` | `25` | 2–60 | Hard cap of gateway completions per run (loop guard: a confused model can't burn quota forever). |
| `LLM_MODE` | `gateway` | `gateway` \| `mock` | `mock` = deterministic fake model for local dev; **rejected in production**. |

### Server

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8788` | Render injects its own — leave it to the platform. |
| `HOST` | `0.0.0.0` | Keep for containers. |
| `LOG_LEVEL` | `info` | pino level (`silent` also supported). |
| `CORS_ORIGINS` | `*` | Comma-separated explicit origins — set to your frontend URL for production (`https://your-frontend.onrender.com`). |
| `CONFIG_DIR` | `./config` | Where `profiles.json`, `mcp.json`, `skills.json` are read (validated at boot — typos fail fast). |
| `DATA_DIR` | `./data` | Writable scratch; skills cache lives here. Ephemeral on Render (that's fine — it re-syncs at boot). |
| `DB_POOL_MAX` | `5` | pg pool size (Neon free supports this easily). |

### E2B sandbox

| Var | Default | Meaning |
|---|---|---|
| `E2B_API_KEY` | *(unset → sandbox tools removed from the registry entirely)* | `sandbox.*` tools disappear; chat still works. |
| `E2B_TEMPLATE` | `base` | Sandbox template. |
| `E2B_IDLE_TTL_MS` | `600000` (10 min) | Sandbox dies after this idle gap; next tool call recreates it. Protects your one-time $100 credit. |
| `E2B_MAX_SESSION_MS` | `3300000` (55 min) | Max reuse window (Hobby caps sessions at 1 h — we stay under it). |
| `E2B_EXEC_TIMEOUT_MS` | `300000` (5 min) | Ceiling for one `sandbox.exec`/`python` command. |
| `SANDBOX_MINUTES_PER_USER_DAY` | `30` | Per-user daily sandbox minutes; over → `sandbox.*` returns a quota message to the model. |

### Limits & safety

| Var | Default | Meaning |
|---|---|---|
| `RUN_RATE_PER_MIN` | `10` | `POST /v1/runs` per user (token bucket). |
| `API_RATE_PER_MIN` | `120` | All other authenticated requests per user. |
| `APPROVAL_TIMEOUT_MS` | `900000` (15 min) | Unanswered human-approval requests **auto-deny** at this deadline (fail-safe). |
| `TOOL_RESULT_MAX_BYTES` | `12288` | Every tool result truncated (head 70 %/tail 30 % + marker) before the model sees it. Keeps runs inside the gateway's 2 MiB body cap. |
| `ARTIFACT_MAX_BYTES` | `10485760` (10 MB) | Max artifact streamed out of the sandbox. |

### MCP server tokens (each referenced inside `config/mcp.json`)

| Var | Server gated |
|---|---|
| `MCP_TAVILY_API_KEY` | Tavily search |
| `MCP_BROWSERLESS_TOKEN` | Browserless (real browsing/screenshots) |
| `MCP_AZURE_VISION_TOKEN` | your Azure vision server |
| `MCP_AZURE_DOC_TOKEN` | your Azure doc server |
| `MCP_POLLINATIONS_KEY` | Pollinations (image gen — it now requires a key) |
| `MCP_GITHUB_PAT` | GitHub Copilot MCP (server also `enabled:false` by default) |
| `MCP_CLOUDFLARE_TOKEN` | Cloudflare MCP (`enabled:false` default) |
| `MCP_CLOUDINARY_BASIC` | Cloudinary (base64 of `key:secret`, `enabled:false` default) |
| `MCP_NEON_KEY` | Neon MCP (`enabled:false` default — DB-admin tools are intentionally off for agents) |
| `GITHUB_TOKEN` | optional; raises GitHub API rate for skills sync (anonymous works too) |

Missing token ⇒ **that server self-disables at boot** (tools just aren't offered); it never crashes the orchestrator.

---

## 2. Render deployment — step by step (two-account topology, plan §3.1)

### Topology you chose

```text
Account A ── gateway web service (Docker) + frontend static site (0 hours, never sleeps)
Account B ── orchestrator web service (Docker)            ← this repo
each web service ≈ 744 h/month ≤ 750 h workspace budget → one always-on service per account
cron-job.org → GET /health on BOTH web services every ~2 min (never /ready, never chat)
```

### Step 0 — prerequisites (checklist)

1. **Gateway deployed** and answering `https://<gateway>/health`.
2. **Gateway routes configured for tool calling** — the loop dies without a `tool_calls`-capable model. In the *gateway's* env, `ROUTE_REASONING` and `ROUTE_BALANCED` must contain at least one function-calling model (the orchestrator's `code`/`power` profiles call `model:"reasoning"`; `chat` calls `balanced`; `research` calls `long-context`). If a route alias is unset, the gateway answers 503 `no_route`. **No `ROUTE_LONG_CONTEXT`?** Edit `config/profiles.json` → set the `research` profile's `route` to `"balanced"` — everything else (budgets, deny lists) keeps working.
3. `npm run spike:gateway` passing locally against that gateway (M0 contract check).
4. **This repo pushed to GitHub** (`git init && git add -A && git commit && git push` — commit `package-lock.json`, the Docker build uses `npm ci`).
5. **Neon** project created (optional today, but strongly recommended): copy the *pooled* connection string (keep `?sslmode=require`).
6. **E2B** dashboard → API key (Hobby: one-time $100 credit, 20 concurrent, 1 h sessions).
7. **Frontend URL** (whatever it ends up being) so `CORS_ORIGINS` isn't `*`.

### Step 1 — create the service (Account B)

**Option A — Blueprint (recommended):** push `render.yaml` (already in this repo) → in Account B: *New → Blueprint* → pick the repo → fill the prompted secret values → Deploy.

**Option B — manual:** *New → Web Service* → connect repo → configure:

| Field | Value |
|---|---|
| Runtime | **Docker** (Render detects the Dockerfile; no build/start commands needed) |
| Instance type | **Free** |
| Region | **Singapore (ap-southeast1)** — same as the gateway, lowest latency for you |
| Health check path | `/health` |
| Auto-deploy | on (every push rebuilds — see the “before deploying” rule in §4) |

Then **Environment** tab → add every var from the tables above (mark secrets as *Secret*). Minimum set to boot: `NODE_ENV=production`, `GATEWAY_BASE_URL`, `GATEWAY_API_KEY`, `ORCH_MASTER_KEY`, `CORS_ORIGINS`, plus `DATABASE_URL`, `E2B_API_KEY` and whichever `MCP_*` you have. Do **not** set `PORT` (Render injects it).

> Note `GATEWAY_BASE_URL` must be the gateway's **public URL** — two accounts can't share Render's private network, so the gateway stays internet-facing behind its Bearer key (that's its existing design).

Deploy → logs should end with `agent-orchestrator listening on 0.0.0.0:<PORT> …`.

### Step 2 — frontend (Account A)

Static site (*New → Static Site*): build `npm run build`, publish dir `dist/` — never spins down, costs no instance-hours, no pinger needed. It must call the orchestrator at `https://<orchestrator>.onrender.com` and only ever hold the issued `ok_…` client key — never the gateway or MCP keys.

### Step 3 — keep-alive (cron-job.org)

Two jobs (one per web service), same pattern:

```text
URL:     https://<orchestrator>.onrender.com/health     (and https://<gateway>.onrender.com/health)
Cron:    */2 * * * *        Method: GET     Timeout: default (30 s is fine)
Enable failure notification  ← doubles as "service suspended for hours" alert
```

Never point them at `/ready` (it fans out to PG/gateway/E2B) or any `/v1/*` path (rate limits + quota). `/health` on both services is public, O(1), and unauthenticated by design.

### Step 4 — issue the frontend's key + verify (run from your machine)

```bash
O=https://<orchestrator>.onrender.com
K=<ORCH_MASTER_KEY>

curl -s $O/health; echo
curl -s $O/ready -H "authorization: Bearer $K"; echo        # store/gateway/sandbox/mcp states
curl -s -X POST $O/admin/keys -H "authorization: Bearer $K" \
     -H 'content-type: application/json' \
     -d '{"user_id":"frontend-app","label":"part-2","profile":"code"}'   # returns ok_… — show once, store in frontend config

RID=$(curl -s -X POST $O/v1/runs -H "authorization: Bearer ok_…" \
      -H 'content-type: application/json' \
      -d '{"message":"What time is it? Also list your tools."}' | sed 's/.*"run_id":"\([^"]*\)".*/\1/')
sleep 8 && curl -s "$O/v1/runs/$RID/events?format=json" -H "authorization: Bearer ok_…" | head -c 600
```

Expected: `run_started → model_step → tool_call_started (orch.time_now) → … → run_finished`. If `state:"failed"` with `gateway error 503: no configured provider route` → fix the **gateway's** `ROUTE_*` env, not the orchestrator.

---

## 3. How a request flows (the whole machine in 12 lines)

1. Frontend `POST /v1/runs {message, session_id?, profile?}` with its `ok_…` key. Rate-checked, profile validated, session+run rows created, **202** + `run_id` returned immediately — execution is async and survives client disconnects.
2. `RunEngine` builds the transcript: **system contract + skills manifest + durable recall + condensed past turns**, then loop (≤ `loopMaxIterations`, ≤ wall-clock, ≤ 25 gateway calls).
3. Each iteration: one **non-streaming** gateway completion (`model:"reasoning"`, OpenAI `tools` = the run's merged registry). Gateway picks a provider, fails over, stores nothing for tool loops (we own the transcript — plan §6/D1).
4. `finish_reason:"tool_calls"` → every call: JSON-schema validate → **Policy** (deny patterns / jail check / allow-review per profile) → mutating+ungated calls **pause the run** for `POST /v1/runs/:id/approve` → execute on the right `ToolSource` (builtin / E2B / MCP) → truncate to 12 KB → scrub secrets → wrap untrusted data in `EXTERNAL_UNTRUSTED` markers → append as `role:"tool"`.
5. `finish_reason:"stop"` → final answer stored on the run, journal closes, and a durable-memory writeback fires to the gateway (`POST /v1/memories`, per-user `X-Agent-ID`) so future sessions recall it.
6. The frontend watches everything live via `GET /v1/runs/:id/events` (SSE, `id:` = journal seq, `Last-Event-ID` reconnect replays) — events are the audit truth, rendered from `run_events`.

## 4. Operations

**Personal-use tuning (single trusted user — suggested values):**

| var | suggest | why |
|---|---|---|
| `RUN_RATE_PER_MIN` | `30` | the default 10 throttles you, not attackers; you are the only tenant |
| `GATEWAY_MAX_CALLS_PER_RUN` | `40` | a 16-iteration research loop + retries exceeds the 25 cap |
| `TOOL_RESULT_MAX_BYTES` | `24576` if gateway body limit allows | research reads big files; keep ≤ ¼ of the gateway's 2 MiB cap across ~40 context messages |
| `SANDBOX_MINUTES_PER_USER_DAY` | `60` | default 30 burns mid-session on long coding tasks (E2B time is the only real cost) |
| `APPROVAL_TIMEOUT_MS` | leave as-is, or use `code`/`research` profiles which auto-approve; `power` is the one that asks |

Use sessions + briefs, not one giant session: one session per project, set `context` once (`Repo: user/app; tests: npm test; deliver notes to /workspace/notes.md`), then every run inherits it.

- **Before every deploy**: `GET /ready` shows `active_runs` — restarting kills in-flight runs (they become `interrupted`).
- **Skills**: push to `agent-skills` repo → `POST /admin/skills/sync`. Pin `config/skills.json` `ref` to a commit SHA for stable behavior; the condensed manifest (~2 KB) regenerates automatically.
- **MCP**: edit `config/mcp.json` (push) or hot-list-change via `POST /admin/mcp/refresh`. `GET /ready` lists each server's state/tool count/last error.
- **Profiles**: every capability/safety change is `config/profiles.json` (allow/deny/auto-approve/review lists, budgets, route alias) — no code. Shipped: `chat` / `research` / `code` / `power`.
- **Session briefs**: one `context` string per project (repo, conventions, output paths) rides on `POST /v1/runs`, is persisted on the run row, and is auto-inherited by later runs in the same session — injected after the system prompt on every model call. The newest non-empty brief in the session wins; send a new `context` on any run to replace it for that session going forward.
- **Runaway behavior**: `RUN_RATE_PER_MIN` + `GATEWAY_MAX_CALLS_PER_RUN` + iteration guard; identical-call×3 and 3-consecutive-failures produce guard nudges instead of more spend.
- **Troubleshooting**: `no_route`/503 → gateway routes; `401` from gateway → `GATEWAY_API_KEY`; `sandbox disabled` → `E2B_API_KEY`; `skills: not-synced` in `/ready` → outbound GitHub blocked (use `SKILLS_DIR`/`dir` config or `GITHUB_TOKEN`); 429 from us → lower rates or ask users to slow down; service suspended mid-month → hours exhausted → drop the cron job or pay $7.
- **Free-tier watch**: Workspace → Usage (6 h/month headroom on each account); cron failure notification = your early-warning.

## 5. Security posture (what's enforced in code, not vibes)

Two key rings (frontend key ≠ gateway key ≠ MCP tokens); SHA-256+constant-time key check; per-run `X-Request-ID`; per-user agent isolation incl. session ownership checks (`404`, not `403`, on foreign runs); every tool call audited (`tool_calls` table + `/v1/runs/:id/tool-calls`); denylist-before-approval-before-execution; sandbox never receives any secret env; SSRF-blocked fetch; HTML stripped to text; body limit 1.5 MB + schema-validated payloads; auth header redacted from logs; error strings scrubbed before they reach model or client; approval timeouts deny by default.
