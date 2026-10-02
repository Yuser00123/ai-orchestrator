#!/usr/bin/env python3
"""Deep functional probe: exercises the heavy user-facing features against a live
deployment (real gateway tokens spent): research+web-search run, sandbox+artifact
round-trip, human approval flow. Appends a section to the given report file.

  ORCH_MASTER_KEY=*** python3 scripts/deep_probe.py [--url URL] [--out report_live.txt]
"""
import argparse, json, os, re, ssl, sys, time, urllib.error, urllib.request

BASE = os.environ.get("ORCH", "https://agent-orchestrator-e0i2.onrender.com").rstrip("/")
KEY = os.environ.get("ORCH_MASTER_KEY", "")
CTX = ssl.create_default_context()

def req(method, path, body=None, token=None, raw=False, timeout=45):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Authorization", f"Bearer {token or KEY}")
    if data: r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            payload = resp.read()
            st = resp.status
    except urllib.error.HTTPError as e:
        payload, st = e.read(), e.code
    except Exception as e:
        return 0, str(e).encode() if not raw else str(e)
    if raw: return st, payload.decode("utf-8", "replace")
    try: return st, json.loads(payload)
    except Exception: return st, payload.decode("utf-8", "replace")

def wait(run_id, states, deadline):
    st = body = None
    until = time.monotonic() + deadline
    while time.monotonic() < until:
        st, body = req("GET", f"/v1/runs/{run_id}")
        state = body.get("state") if isinstance(body, dict) else None
        if state in states: return state, body
        time.sleep(3)
    return "TIMEOUT", body or {}

L = []
log = L.append
ok = fail = 0
def check(name, cond, detail=""):
    global ok, fail
    if cond: ok += 1; log(f"[PASS] {name}" + (f"  ({detail})" if detail else ""))
    else: fail += 1; log(f"[FAIL] {name}  → {detail}")

def start(profile, message, session=None, context=None):
    b = {"profile": profile, "message": message}
    if session: b["session_id"] = session
    if context: b["context"] = context
    st, r = req("POST", "/v1/runs", b)
    if not (isinstance(r, dict) and st == 202):
        log(f"[INFO] rejected POST /v1/runs ({profile}): HTTP {st} {str(r)[:180]}")
        return None
    return r.get("run_id")

def audit(run_id):
    st, tc = req("GET", f"/v1/runs/{run_id}/tool-calls")
    calls = tc.get("calls", []) if isinstance(tc, dict) else []
    return {c.get("name"): c for c in calls if isinstance(c, dict)}, calls

def events(run_id, kind):
    st, ev = req("GET", f"/v1/runs/{run_id}/events?format=json")
    out = [e for e in (ev.get("events", []) if isinstance(ev, dict) else []) if e.get("kind") == kind]
    return out

# ───────────────────────────────────────────────────────────── A · research
print("A · research profile: long-context route + live tavily search + skills"); sys.stdout.flush()
rid = start("research", "Use one tavily search tool to find the current latest stable Node.js LTS version number. Then call orch.skills_list once. Then reply with exactly one line: NODE_LTS=<version>", session=f"probeA{int(time.time())}", context="Deep probe session. Be terse, finish in ≤4 steps.")
if not rid:
    check("A1 research run accepted", False, "POST /v1/runs not 202 — check gateway ROUTE_LONG_CONTEXT")
else:
    state, run = wait(rid, ("completed", "failed", "cancelled"), 420)
    check("A1 research run completes on long-context route", state == "completed", state)
    names, calls = audit(rid)
    tav = [n for n in names if n and "tavily" in n]
    check("A2 live MCP web search executed ok", any(names[n].get("ok") for n in tav), f"tavily calls: {tav}")
    check("A3 skills catalog tool executed", "orch.skills_list" in names, sorted(n for n in names if n)[:8])
    check("A4 policy: mutating mcp denied by profile", not any(n and "github" in str(n) for n in names), "no github tool in audit")
    log(f"[INFO] A final answer: {str(run.get('result'))[:140]}")
    log(f"[INFO] A audit: {json.dumps([{ 't':c.get('name'),'ok':c.get('ok'),'ms':c.get('durationMs')} for c in calls][:6])}")

# ───────────────────────────────────────────────────── B · sandbox + artifact
print("B · code profile: E2B sandbox write/exec + final_artifact + download"); sys.stdout.flush()
sess = f"probeB{int(time.time())}"
rid = start("code", "Do exactly: 1) orch.time_now to get the date. 2) sandbox.write_file path=/workspace/hello.txt content='E2B-OK <the date>'. 3) sandbox.exec command='cat /workspace/hello.txt'. 4) orch.final_artifact sandbox_path=/workspace/hello.txt name=hello.txt. Then reply ARTIFACT-DONE.", session=sess)
if not rid:
    check("B1 sandbox run accepted", False, "not 202")
else:
    state, run = wait(rid, ("completed", "failed", "cancelled"), 420)
    check("B1 sandbox run completes (E2B live)", state == "completed", state)
    names, calls = audit(rid)
    check("B2 sandbox.write_file executed ok", names.get("sandbox.write_file", {}).get("ok") is True, json.dumps({k: v.get("ok") for k, v in names.items() if k in ("sandbox.write_file", "sandbox.exec", "orch.final_artifact")}))
    check("B3 sandbox.exec executed ok", names.get("sandbox.exec", {}).get("ok") is True, "auto-approved under code profile")
    check("B4 final_artifact recorded", "orch.final_artifact" in names, "artifact row created")
    st, content = req("GET", f"/v1/runs/{rid}/artifacts/hello.txt", raw=True, timeout=90)
    check("B5 artifact downloadable via REST", st == 200 and "E2B-OK" in str(content), f"HTTP {st}, body[:60]={str(content)[:60]!r}")
    log(f"[INFO] B audit: {json.dumps([{ 't':c.get('name'),'ok':c.get('ok'),'ms':c.get('durationMs')} for c in calls][:8])}")

# ───────────────────────────────────────────────────────────── C · approval
print("C · power profile: human-in-the-loop approval round-trip"); sys.stdout.flush()
rid = start("power", "You MUST call the sandbox.exec tool — do not answer from memory. Run exactly: head -c 24 /proc/uptime — then reply with the literal output verbatim. The reply is only valid if it contains real uptime decimals which cannot be guessed.")
if not rid:
    check("C1 power run accepted", False, "not 202")
else:
    state, _ = wait(rid, ("awaiting_approval", "completed", "failed"), 180)
    check("C2 run paused at awaiting_approval", state == "awaiting_approval", state)
    if state == "awaiting_approval":
        ap = events(rid, "approval_requested")
        tcid = ap[-1].get("payload", {}).get("tool_call_id") if ap else None
        log(f"[INFO] C approval request: tool={ap[-1].get('payload',{}).get('tool') if ap else '?'} args={ap[-1].get('payload',{}).get('args_preview','')[:80] if ap else ''}")
        st, resp = req("POST", f"/v1/runs/{rid}/approve", {"tool_call_id": tcid, "decision": "approved"})
        check("C3 approve accepted", st == 200, f"{st} {str(resp)[:100]}")
        state, run = wait(rid, ("completed", "failed", "cancelled"), 300)
        check("C4 run resumes after approval and completes", state == "completed", state)
        names, calls = audit(rid)
        check("C5 approved sandbox.exec actually executed", names.get("sandbox.exec", {}).get("ok") is True, "exec ok=true post-approval")
        check("C6 approval resolved recorded in journal", bool(events(rid, "approval_resolved")), "approval_resolved event present")
        got = str(run.get("result", "")) + json.dumps([c.get("resultExcerpt", "") for c in calls])
        check("C7 real sandbox output (uptime decimals) came back through the loop",
              bool(re.search(r"\d+\.\d+\s+\d+", got)), got[:120])
    else:
        log("[WARN] C model finished without needing approval — approval path exercised by tests; probe needs one tool ask. state=" + state)

# ───────────────────────────────────────────────────────────────── report
block = ["", "════════════════════════════════════════════════════════════", "DEEP FEATURE PROBE (real tokens, live MCP + E2B + approvals)", f"generated: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}", ""] + L + ["", f"DEEP PROBE SUMMARY: {ok} passed · {fail} failed"]
out = "\n".join(block)
print(out)
ap = sys.argv[1] if len(sys.argv) > 1 else None
import argparse as _a
if "--out" in sys.argv:
    p = sys.argv[sys.argv.index("--out") + 1]
    with open(p, "a") as f: f.write(out + "\n")
    print(f"(appended to {p})")
sys.exit(1 if fail else 0)
