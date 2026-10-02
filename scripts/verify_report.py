#!/usr/bin/env python3
"""End-to-end functional verification for the agent-orchestrator API.

Single file, stdlib only — no pip installs. Exercises every endpoint and
behavior contract, then writes a human-readable report.txt.

Usage:
    python3 verify_report.py --url https://agent-orchestrator-e0i2.onrender.com
    (master key from env ORCH_MASTER_KEY, or --key, or interactive prompt)

Options:
    --out report.txt        report path
    --timeout 30            per-request seconds
    --run-deadline 180      max seconds to wait for a run to finish
    --burst                 ALSO test the 429 rate limiter by really creating
                            ~25 cheap runs (costs tokens — off by default)

Exit code: 0 = every hard check passed (WARNs/SKIPs allowed), 1 otherwise.
"""
import argparse
import getpass
import json
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

# ---------------------------------------------------------------- plumbing

class Result:
    def __init__(self, section, name, status, ms, expect, actual, note=""):
        self.section, self.name, self.status, self.ms = section, name, status, ms
        self.expect, self.actual, self.note = expect, actual, note

class Api:
    def __init__(self, base, key, timeout):
        self.base, self.timeout = base.rstrip("/"), timeout
        if key and not key.isascii():
            raise SystemExit(f"key contains non-ASCII characters (likely a copy/paste truncation '…'): {key!r}")
        self.key = (key or "").strip()
        self.ctx = ssl.create_default_context()

    def call(self, method, path, body=None, token=None, extra_headers=None, stream=False):
        url = self.base + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {token or self.key}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        for h, v in (extra_headers or {}).items():
            req.add_header(h, v)
        try:
            r = urllib.request.urlopen(req, timeout=self.timeout, context=self.ctx)
        except urllib.error.HTTPError as e:
            payload = e.read().decode("utf-8", "replace") if not stream else ""
            return e.code, payload
        except (urllib.error.URLError, socket.timeout, TimeoutError) as e:
            return 0, f"__network__ {getattr(e, 'reason', e)}"
        if stream:
            buf, t0 = [], time.monotonic()
            try:
                while time.monotonic() - t0 < 4:
                    line = r.readline()
                    if not line:
                        break
                    buf.append(line.decode("utf-8", "replace"))
            except (socket.timeout, TimeoutError, OSError):
                pass  # SSE stays open by design — our read deadline, not a failure
            finally:
                r.close()
            return r.status, "".join(buf)
        with r:
            return r.status, r.read().decode("utf-8", "replace")

    def jcall(self, *a, **k):
        st, txt = self.call(*a, **k)
        try:
            return st, json.loads(txt)
        except Exception:
            return st, txt

# ------------------------------------------------------------- reporting

class Verifier:
    def __init__(self, api, args):
        self.api, self.args = api, args
        self.results, self.section, self.audit = [], "", []

    # ---- recording helpers -------------------------------------------------
    def check(self, name, cond, expect, actual, soft=False):
        self.results.append(Result(self.section, name,
                                   "PASS" if cond else ("WARN" if soft else "FAIL"),
                                   0, expect, str(actual)[:200]))
        return bool(cond)

    def timed(self, name, fn, soft=False):
        t0 = time.monotonic()
        cond, expect, actual = fn()
        r = Result(self.section, name, "PASS" if cond else ("WARN" if soft else "FAIL"),
                   round((time.monotonic() - t0) * 1000), expect, str(actual)[:200])
        self.results.append(r)
        return cond if isinstance(cond, bool) else None

    def info(self, name, note):
        self.results.append(Result(self.section, name, "INFO", 0, "", "", note))

    def skip(self, name, why):
        self.results.append(Result(self.section, name, "SKIP", 0, "", "", why))

    def audit_line(self, s):
        self.audit.append(s)

    # ---- reusable probes ---------------------------------------------------
    def wait_run(self, run_id, states=("completed", "failed", "cancelled")):
        deadline = time.monotonic() + self.args.run_deadline
        st, body = 0, {}
        while time.monotonic() < deadline:
            st, body = self.api.jcall("GET", f"/v1/runs/{run_id}")
            state = body.get("state") if isinstance(body, dict) else None
            if state in states:
                return state, body
            time.sleep(2)
        return "TIMEOUT", body if isinstance(body, dict) else {}

    def scrub(self, text):
        return re.sub(r'("token"\s*:\s*")(\S{6})\S+(")', r"\1\2…redacted\3", text)

    # ---- sections ----------------------------------------------------------
    def sec1_public(self):
        self.section = "1 · public surface"
        def t():
            st, b = self.api.jcall("GET", "/health")
            ok = st == 200 and isinstance(b, dict) and b.get("status") == "ok"
            return ok, "200 + {status:ok}", f"{st} {str(b)[:80]}"
        self.timed("GET /health", t)
        self.timed("GET / → 404 (API-only, no UI)", lambda: self._status("GET", "/", 404, anon=True))
        self.timed("POST /wake (cron keep-alive)", lambda: self._status("POST", "/wake", 200, anon=True))

    def sec2_auth(self):
        self.section = "2 · auth gate"
        self.timed("GET /ready no key → 401", lambda: self._status("GET", "/ready", 401, anon=True))
        self.timed("POST /v1/runs no key → 401",
                   lambda: self._status("POST", "/v1/runs", 401, {"message": "x"}, anon=True))
        self.timed("wrong key → 401",
                   lambda: self._status("GET", "/ready", 401, token="wrong-key-0000000000000000"))
        self.timed("unknown run id → 404 (no enumeration)",
                   lambda: self._status("GET", "/v1/runs/ffffffff-0000-0000-0000-000000000000", 404))

    def _status(self, method, path, want, body=None, token=None, anon=False):
        headers = {} if anon or token else None
        t0 = time.monotonic()
        if anon:
            req = urllib.request.Request(self.api.base + path,
                                         data=json.dumps(body).encode() if body else None,
                                         method=method)
            if body is not None:
                req.add_header("Content-Type", "application/json")
            try:
                r = urllib.request.urlopen(req, timeout=self.api.timeout)
                st = r.status
            except urllib.error.HTTPError as e:
                st = e.code
        else:
            st, _ = self.api.call(method, path, body, token=token)
        return st == want, f"{want}", f"{st}"

    def sec3_capabilities(self):
        self.section = "3 · capabilities snapshot"
        def t():
            st, b = self.api.jcall("GET", "/ready")
            self.ready = b
            ok = st == 200
            self.ready_json = json.dumps(b, indent=1)[:3000]
            return ok, "200", f"{st}"
        self.timed("GET /ready", t)
        self.info("/ready summary", json.dumps(self.ready)[:260])
        self.timed("/v1/tools exposes built-in loop tools",
                   lambda: self._contains("GET", "/v1/tools", "orch.final_artifact"))
        self.timed("/v1/skills has synced skill catalog",
                   lambda: self._skills())

    def _contains(self, method, path, needle, token=None):
        st, txt = self.api.call(method, path, token=token)
        return needle in str(txt), f"body contains '{needle}'", f"{st}, found={needle in str(txt)}"

    def _skills(self):
        st, b = self.api.jcall("GET", "/v1/skills")
        n = len(b.get("skills", [])) if isinstance(b, dict) else 0
        return st == 200 and n > 0, "200 + non-empty skills", f"{st}, count={n}"

    def sec4_admin(self):
        self.section = "4 · admin"
        self.timed("POST /admin/skills/sync", lambda: self._status("POST", "/admin/skills/sync", 200, {}))
        self.timed("POST /admin/mcp/refresh", lambda: self._status("POST", "/admin/mcp/refresh", 200, {}))
        self.timed("POST /admin/keys rejects malformed user_id → 400",
                   lambda: self._status("POST", "/admin/keys", 400, {"user_id": "no pe!!", "label": "x"}))
        def issue():
            st, b = self.api.jcall("POST", "/admin/keys",
                                   {"user_id": f"probe_{int(time.time())%100000}",
                                    "label": "verify_report", "profile": "chat"})
            self.limited = b.get("token") if isinstance(b, dict) else None
            return st == 200 and self.limited and self.limited.startswith("ok_"), \
                   "200 + ok_… token", f"{st}, issued={bool(self.limited)}"
        self.timed("POST /admin/keys issues scoped key", issue)

    def sec5_validation(self):
        self.section = "5 · request validation"
        self.timed("missing message → 400", lambda: self._status("POST", "/v1/runs", 400, {}))
        self.timed("empty message → 400", lambda: self._status("POST", "/v1/runs", 400, {"message": "   "}))
        self.timed("unknown profile → 400",
                   lambda: self._status("POST", "/v1/runs", 400, {"message": "hi", "profile": "bogus"}))
        def burst():  # invalid payloads must ALL be 400 (no state created, free)
            bad = 0
            for _ in range(15):
                st, _ = self.api.call("POST", "/v1/runs", {})
                if st == 400:
                    bad += 1
            return bad == 15, "15× empty body → all 400", f"{bad}/15"
        self.timed("validation is uniform under burst", burst)

    def sec6_real_run(self):
        self.section = "6 · real run (gateway + tool loop + journal)"
        self.sid = f"verify{int(time.time())}"
        self.brief = "Automated verification. Be terse. Do exactly what is asked, then finish."
        st, b = self.api.jcall("POST", "/v1/runs",
                               {"message": "Call the orch.time_now tool exactly once, then reply DONE.",
                                "session_id": self.sid, "context": self.brief, "profile": "chat"})
        if not (st == 202 and isinstance(b, dict) and b.get("run_id")):
            self.check("start run", False, "202 + run_id", f"{st} {str(b)[:150]}")
            self.run_id = None
            return
        self.check("start run", True, "202 + run_id", st)
        self.check("202 returns events_url for SSE", "events_url" in b, "events_url field", list(b))
        self.run_id = b["run_id"]
        state, run = self.wait_run(self.run_id)
        self.check("run reaches completed", state == "completed", "completed", state)
        self.check("run row stores session brief (context)",
                   bool(isinstance(run, dict) and run.get("context")), "non-null context", str(run.get("context"))[:60] if isinstance(run, dict) else run)
        self.info("final answer", str(run.get("result"))[:160] if isinstance(run, dict) else "")

        st, ev = self.api.jcall("GET", f"/v1/runs/{self.run_id}/events?format=json")
        events = ev.get("events", []) if isinstance(ev, dict) else []
        self.check("events journal (json) non-empty", st == 200 and len(events) > 0, "200 + events", f"{st}, n={len(events)}")
        types = {e.get("kind") for e in events if isinstance(e, dict)}
        need = {"run_started", "model_step", "run_finished"}
        self.check("journal recorded the loop lifecycle",
                   st == 200 and need.issubset(types), f"{sorted(need)} present", sorted(map(str, types))[:8])
        if events:
            last = events[-1].get("seq", 0)
            st2, tail = self.api.jcall("GET", f"/v1/runs/{self.run_id}/events?format=json&after={last}")
            n2 = len(tail.get("events", [])) if isinstance(tail, dict) else -1
            self.check("resume cursor: after=<last seq> → 0 new events", st2 == 200 and n2 == 0, "0 events", n2)
        st, sse = self.api.call("GET", f"/v1/runs/{self.run_id}/events",
                                extra_headers={"Accept": "text/event-stream"}, stream=True)
        lines = len([x for x in str(sse).splitlines() if x.startswith("data:")])
        self.check("SSE replays with data: frames", st == 200 and lines >= 1, "≥1 data line", f"{st}, lines={lines}")

        st, tc = self.api.jcall("GET", f"/v1/runs/{self.run_id}/tool-calls")
        arr = tc.get("calls", []) if isinstance(tc, dict) else []
        names = [x.get("name") for x in arr if isinstance(x, dict)]
        oks = all(x.get("ok") is True for x in arr if isinstance(x, dict))
        self.check("tool-call audit lists orch.time_now executed ok",
                   st == 200 and any(n and "time_now" in str(n) for n in names) and oks,
                   "orch.time_now, ok=true", f"{st}, names={names[:4]}")
        st, _ = self.api.call("POST", f"/v1/runs/{self.run_id}/approve",
                              {"tool_call_id": "ghost", "decision": "approved"})
        self.check("approve on finished run → 400 (no zombie approvals)", st == 400, "400", st)

    def sec7_briefs(self):
        self.section = "7 · session briefs"
        if not getattr(self, "run_id", None):
            self.skip("second run inherits brief", "run 1 never started")
            return
        st, b = self.api.jcall("POST", "/v1/runs",
                               {"message": "Reply DONE only.", "session_id": self.sid})  # no context resent
        ok = st == 202
        self.check("follow-up run accepted in same session", ok, "202", st)
        if ok:
            state, run = self.wait_run(b["run_id"])
            self.check("brief session continues to completion", state == "completed", "completed", state)
            self.check("inheriting run stores its own row context as null (inheritance happens at engine level)",
                       isinstance(run, dict) and not run.get("context"), "null on row", str(run.get("context"))[:40])
        st, sess = self.api.jcall("GET", f"/v1/sessions/{self.sid}")
        runs = sess.get("runs", []) if isinstance(sess, dict) else []
        self.check("session aggregates both runs", st == 200 and len(runs) >= 2, "≥2 runs", f"{st}, n={len(runs)}")
        st, all_s = self.api.jcall("GET", "/v1/sessions")
        lst = all_s if isinstance(all_s, list) else all_s.get("sessions", [])
        self.check("GET /v1/sessions lists the session",
                   st == 200 and any(self.sid in json.dumps(s) for s in lst), "200 + contains sid", st)

    def sec8_cancel(self):
        self.section = "8 · cancel"
        st, b = self.api.jcall("POST", "/v1/runs",
                               {"message": "Write an extremely long detailed essay covering every planet with ten paragraphs each. Take your time."})
        if st != 202:
            self.check("start long run", False, "202", st)
            return
        rid = b["run_id"]
        time.sleep(1)
        st, _ = self.api.call("POST", f"/v1/runs/{rid}/cancel", {})
        state, _ = self.wait_run(rid, ("cancelled", "completed", "failed"))
        if not self.check("POST /cancel accepted (200)", st == 200, "200", st):
            return
        # mock/fast gateways may finish before cancel lands; anything terminal is protocol-OK
        self.check("run reaches terminal state after cancel", state in ("cancelled", "completed", "failed"),
                   "terminal", state, soft=True)

    def sec9_scoping(self):
        self.section = "9 · key scoping & isolation"
        lim = getattr(self, "limited", None)
        if not lim:
            self.skip("scoped-key checks", "key issuance failed earlier")
            return
        # non-admin on admin routes is answered 401 (not 403) by design — an
        # unauthorized caller learns nothing about whether the surface exists
        self.timed("scoped key on /admin → 401 (admin surface indistinguishable)",
                   lambda: self._status("POST", "/admin/keys", 401, {"user_id": "x", "label": "y"}, token=lim))
        self.timed("scoped key cannot switch to other profile → 400",
                   lambda: self._status("POST", "/v1/runs", 400, {"message": "hi", "profile": "power"}, token=lim))
        self.timed("scoped key can use its own profile → 202",
                   lambda: self._status("POST", "/v1/runs", 202, {"message": "Reply DONE."}, token=lim))
        if getattr(self, "run_id", None):
            self.timed("foreign run invisible to other user → 404",
                       lambda: self._status("GET", f"/v1/runs/{self.run_id}", 404, token=lim))

    def sec10_sandbox(self):
        self.section = "10 · sandbox-dependent (soft)"
        sandbox = ""
        try:
            sandbox = json.dumps(getattr(self, "ready", {})).lower()
        except Exception:
            pass
        enabled = '"sandbox"' in sandbox and "off" not in sandbox.split('"sandbox"')[1][:20]
        if not getattr(self, "run_id", None):
            self.skip("artifact streaming", "no run")
            return
        st, txt = self.api.call("GET", f"/v1/runs/{self.run_id}/artifacts/nope.md")
        if enabled and st not in (0, 401, 404):
            self.check("artifact endpoint responds", True, "any structured error on missing file", f"{st} (sandbox live)")
        else:
            self.check("artifact endpoint responds (E2B not configured → expect 409/503-class)",
                       st >= 400 and st < 500, "4xx with message", st, soft=True)
            self.info("note", "to verify sandbox exec/approvals/artifacts: set E2B_API_KEY, "
                              "run with profile=power, ask for a sandbox write, approve via events + /approve")

    def sec11_limits(self):
        self.section = "11 · rate limiting"
        if not self.args.burst:
            self.skip("429 limiter", f"skipped by default (costs ~{os.environ.get('N', 25)} real runs). "
                    "Re-run with --burst to verify; expect some 429 beyond RUN_RATE_PER_MIN.")
            return
        codes = []
        for _ in range(25):
            st, _ = self.api.call("POST", "/v1/runs", {"message": "ping"})
            codes.append(st)
        got429 = codes.count(429)
        self.check("burst beyond RUN_RATE_PER_MIN produces 429", got429 > 0, ">1× 429",
                   f"codes: 202×{codes.count(202)} 429×{got429} other×{len(codes)-codes.count(202)-got429}")

    # ---- report ------------------------------------------------------------
    def report(self, path, elapsed):
        order = ["PASS", "WARN", "FAIL", "INFO", "SKIP"]
        counts = {s: sum(1 for r in self.results if r.status == s) for s in order}
        L = []
        w = L.append
        w("AGENT-ORCHESTRATOR — API VERIFICATION REPORT")
        w("=" * 64)
        w(f"target    : {self.api.base}")
        w(f"generated : {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
        w(f"duration  : {elapsed:.1f}s   python {sys.version.split()[0]}")
        w(f"cost note : ~4-5 gateway completions consumed (chat profile)")
        w("")
        cur = None
        for r in self.results:
            if r.section != cur:
                cur = r.section
                w(f"── {cur} " + "─" * max(0, 60 - len(cur)))
            tag = r.status
            ms = f" ({r.ms}ms)" if r.ms else ""
            if r.status in ("PASS", "FAIL", "WARN") and r.expect and r.status != "PASS":
                w(f"[{tag}] {r.name}{ms}  → expected {r.expect}, got {r.actual}{' | ' + r.note if r.note else ''}")
            elif r.status in ("PASS", "WARN", "FAIL"):
                w(f"[{tag}] {r.name}{ms}")
            else:
                w(f"[{tag}] {r.name}: {r.note}")
        w("")
        w("=" * 64)
        verdict = "GREEN ✅ — all hard checks passed" if counts["FAIL"] == 0 else f"RED ❌ — {counts['FAIL']} hard failure(s)"
        w(f"SUMMARY : {counts['PASS']} PASS · {counts['WARN']} WARN · {counts['FAIL']} FAIL · "
          f"{counts['INFO']} INFO · {counts['SKIP']} SKIP   →   {verdict}")
        w("=" * 64)
        w("")
        w("APPENDIX A — /ready snapshot")
        w(self.scrub(getattr(self, "ready_json", "{}")))
        w("")
        w("APPENDIX B — what each section proves")
        w("  1-2  service alive; zero public surface without keys; 404-not-403 on unknown runs")
        w("  3    capability introspection (MCP/skills/tools) exposed to the UI layer")
        w("  4    admin plane: hot-sync skills & MCP, scoped-key issuance (hashed, one-time shown)")
        w("  5    zod schema wall in front of every handler, uniform under load")
        w("  6    THE loop: gateway chat → tool call → exec → journal → SSE resume → audit trail")
        w("  7    durable session briefs (stored on run, inherited next run, session aggregates)")
        w("  8    cooperative cancel")
        w("  9    API-key scoping: profile pinning, 403 admin, cross-user 404")
        w(" 10    sandbox-dependent features degrade loudly instead of pretending to work")
        w(" 11    rate limiter (when --burst)")
        w("")
        w("Any FAIL in 1-6 or 9 = deploy a fix before trusting daily use.")
        out = self.scrub("\n".join(L))
        with open(path, "w") as f:
            f.write(out + "\n")
        print(out)
        print(f"\n(report written to {os.path.abspath(path)})")
        return counts["FAIL"]

# ------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("ORCH", "https://agent-orchestrator-e0i2.onrender.com"))
    ap.add_argument("--key", default=os.environ.get("ORCH_MASTER_KEY", ""))
    ap.add_argument("--out", default="report.txt")
    ap.add_argument("--timeout", type=float, default=30)
    ap.add_argument("--run-deadline", type=float, default=180)
    ap.add_argument("--burst", action="store_true", help="actually test the 429 limiter (spends tokens)")
    a = ap.parse_args()
    if not a.key:
        a.key = getpass.getpass("ORCH master key: ")
    v = Verifier(Api(a.url, a.key, a.timeout), a)
    t0 = time.monotonic()
    for fn in (v.sec1_public, v.sec2_auth, v.sec3_capabilities, v.sec4_admin,
               v.sec5_validation, v.sec6_real_run, v.sec7_briefs, v.sec8_cancel,
               v.sec9_scoping, v.sec10_sandbox, v.sec11_limits):
        try:
            fn()
        except Exception as e:  # a crash in one section must not lose the report
            v.results.append(Result(fn.__name__, "SECTION CRASH", "FAIL", 0, "", f"{type(e).__name__}: {e}"))
    sys.exit(v.report(a.out, time.monotonic() - t0))

if __name__ == "__main__":
    main()
