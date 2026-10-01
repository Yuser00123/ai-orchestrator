# agent-orchestrator

API-only brain of the web AI agent. Owns the agent loop, all tool calling (built-ins + E2B sandbox + MCP servers), skills progressive disclosure, run lifecycle, and safety policy. **All model access goes exclusively through the Unified AI Memory Gateway** — this service holds the gateway key; browsers never do.

Design source: `../ORCHESTRATOR_PLAN.md` (module contracts §11, loop §4, safety §9).

## Quick start (no external services needed)

```bash
npm ci
npm run build
LLM_MODE=mock ORCH_MASTER_KEY=dev-key-0123456789ab node dist/server.js
# in another terminal:
curl -s -X POST localhost:8788/v1/runs \
  -H "authorization: Bearer dev-key-0123456789ab" -H 'content-type: application/json' \
  -d '{"message":"hello"}'
```

Real model runs: point it at your gateway — `GATEWAY_BASE_URL=... GATEWAY_API_KEY=... LLM_MODE=gateway`.
Gateway contract spike (M0 — run this first, once): `GATEWAY_BASE_URL=... GATEWAY_API_KEY=... npm run spike:gateway`.

## Checks

```bash
npm run check          # tsc --noEmit
npm run check:arch     # module-boundary enforcement (one module, one face)
npm test              # 33 tests: loop e2e against the real engine + security units
```

## Endpoints (frontend contract)

| | |
|---|---|
| `POST /v1/runs` | `{message, session_id?, profile?, context?}` → `202 {run_id, session_id, events_url}`; `context` = durable **session brief** (project ground rules), injected into every call of the session and inherited by later runs |
| `GET /v1/runs/:id` | snapshot (state, result, usage counters) |
| `GET /v1/runs/:id/events` | SSE (resumable via `Last-Event-ID`); `?format=json` for polling |
| `POST /v1/runs/:id/approve` | `{tool_call_id, decision: approved|denied}` for `approval_requested` events |
| `POST /v1/runs/:id/cancel` | cooperative cancel between iterations/tools |
| `GET /v1/runs/:id/tool-calls` | audit trail (args + result excerpts + policy action) |
| `GET /v1/runs/:id/artifacts/:name` | stream a `/workspace` file out of the sandbox |
| `GET /v1/sessions`, `GET /v1/sessions/:id` | session transcripts (run summaries) |
| `GET /v1/skills`, `GET /v1/tools` | capability introspection for the UI |
| `POST /admin/keys` | issue per-client API keys (`ok_…`, master only) |
| `POST /admin/skills/sync`, `/admin/mcp/refresh` | hot-reload capability sources |
| `GET /health` | public, O(1) — this is the cron-job.org keep-alive target (never ping `/ready`) |

Auth: `Authorization: Bearer <key>`. Frontend gets an issued `ok_…` key; the master key is admin.

## Configuration

- `config/mcp.json` — MCP servers (remote HTTP; stdio supported but off). A server whose credential env var is unset self-disables; a dead server only loses its tools.
- `config/profiles.json` — profiles are data: route alias, iteration & wall-clock budgets, tool allow/deny, auto-approve vs review lists. Behavior changes are config, not code. Shipped: `chat` (quick Q&A), `research` (long-context, 16 iterations, 30-min budget, read-only MCP auto-approved, mutating MCP denied — pair with gateway `ROUTE_LONG_CONTEXT`; set route to `balanced` if your gateway lacks it), `code` (reasoning + sandbox auto-approved), `power` (reasoning + human approvals).
- `config/skills.json` — pins `Yuser00123/agent-skills@ref`; synced at boot into `data/skills`, served via `orch.skills_list` / `orch.skills_read` (progressive disclosure).
- Env: see `.env.example`. `DATABASE_URL` empty ⇒ in-memory store (dev only).

## Security model (implemented, not aspirational)

- **Policy module** gates every call: dangerous-pattern denylist (`rm -rf /`, `curl|sh`, `sudo`, env dumps, metadata endpoints, jail-escape paths…), mutating ⇒ human approval unless the profile auto-approves it. Approvals pause the run, expire safely (timeout → denied).
- **External content is data**: all web/MCP/sandbox output is wrapped between `EXTERNAL_UNTRUSTED` markers with anti-injection instructions before the model sees it.
- **Secret scrubbing** both ways: configured secret values + token shapes are redacted from every tool result, error string, and API message.
- **SSRF guard** on the fetch tool: DNS-resolved private/link-local/`*.internal` ranges blocked, manual redirects re-validated, size/time capped.
- **Sandbox jail**: E2B per session, everything under `/workspace`, no secrets in the sandbox env, daily minutes quota per user.
- **Budgets everywhere**: per-run iteration/wall-clock/gateway-call caps, per-key rate limits, 12 KB tool-result truncation (keeps the gateway's 2 MiB body cap and ~12 K context honest).
- **Isolation**: per-user `X-Agent-ID` on gateway calls (memory isolation + rate budget), session-scoped data access checks on every read, memory IDs never exposed.

## Known v1 limits (documented, by design)

Single instance; approval state is in-process (a re-deploy interrupts active runs → they become `interrupted`, retry by posting the message again). Transcript is orchestrator-owned (plan §6 D1) — gateway sessions store final exchanges for durable recall, not the raw tool loop. Cohere tool support and `no_route` behavior come from your gateway — check `npm run spike:gateway` output for your route model list and set `ROUTE_REASONING` to a tool-capable model.
