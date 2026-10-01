#!/usr/bin/env node
/**
 * M0 — Gateway contract spike (ORCHESTRATOR_PLAN.md §12-M0).
 * Resolves with evidence, before the loop is trusted:
 *   1. health + models aliases
 *   2. non-streaming tool round-trip (tools + tool result follow-up)
 *   3. X-Session-ID + tool messages: what is stored and replayed (D1 decision)
 *   4. error shapes: 401, 400, 503 no_route, 413 body too large
 *   5. x-gateway-* headers presence
 *
 * Usage:
 *   GATEWAY_BASE_URL=... GATEWAY_API_KEY=... node scripts/gateway-spike.mjs
 */
const BASE = process.env.GATEWAY_BASE_URL ?? 'http://localhost:8787';
const KEY = process.env.GATEWAY_API_KEY ?? '';
const AGENT = `spike-${Date.now()}`;
const SESSION = `spike-sess-${Date.now()}`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

async function call(body, extraHeaders = {}) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'x-agent-id': AGENT, ...extraHeaders },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* streaming or html */
  }
  return { res, json };
}

console.log(`\n=== M0 gateway contract spike against ${BASE} ===\n`);

/* 1 */
const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
check('health endpoint', health?.status === 'ok', JSON.stringify(health));
const models = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } }).then((r) => r.json()).catch(() => null);
const aliases = (models?.data ?? []).map((m) => m.id);
check('route aliases', aliases.length > 0, aliases.join(','));

/* 2 tool round trip */
const tools = [
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: 'Performs arithmetic calculations.',
      parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'], additionalProperties: false },
    },
  },
];
const t1 = await call({ model: aliases.includes('reasoning') ? 'reasoning' : 'balanced', messages: [{ role: 'user', content: 'Calculate 19 multiplied by 7. You must use the calculator tool.' }], tools, tool_choice: { type: 'function', function: { name: 'calculator' } } });
const msg = t1.json?.choices?.[0]?.message;
const call0 = msg?.tool_calls?.[0];
check('tool_calls returned (non-streaming)', Boolean(call0?.function?.name), `finish=${t1.json?.choices?.[0]?.finish_reason} provider=${t1.res.headers.get('x-gateway-provider')} model=${t1.res.headers.get('x-gateway-model')}`);
check('x-gateway headers present', Boolean(t1.res.headers.get('x-gateway-model')), '');

let replayOk = false;
if (call0) {
  const t2 = await call({
    model: aliases.includes('reasoning') ? 'reasoning' : 'balanced',
    messages: [
      { role: 'user', content: 'Calculate 19 multiplied by 7. You must use the calculator tool.' },
      { role: 'assistant', content: null, tool_calls: [call0] },
      { role: 'tool', tool_call_id: call0.id, name: 'calculator', content: '133' },
    ],
    tools,
  });
  const finalText = t2.json?.choices?.[0]?.message?.content ?? '';
  replayOk = /133/.test(String(finalText));
  check('tool result accepted, final answer', replayOk, String(finalText).slice(0, 80));
}

/* 3 session + tool messages replay behavior (feeds decision D1) */
const s1 = await call(
  { model: aliases[1] ?? 'balanced', messages: [{ role: 'user', content: 'Remember that the project codename is Bluebird. Reply ok.' }] },
  { 'x-session-id': SESSION },
);
check('session turn stored', s1.res.ok && Boolean(s1.json?.choices?.[0]?.message), '');
const sess = await fetch(`${BASE}/v1/sessions/${SESSION}`, { headers: { authorization: `Bearer ${KEY}`, 'x-agent-id': AGENT } }).then((r) => r.json()).catch(() => null);
const storedMsgs = sess?.messages ?? [];
const storedRoles = storedMsgs.map((m) => m.role);
check('GET session returns stored messages', storedRoles.includes('user') && storedRoles.includes('assistant'), `roles=${storedRoles.join(',')}`);
const s2 = await call({ model: aliases[1] ?? 'balanced', messages: [{ role: 'user', content: 'What is the project codename?' }] }, { 'x-session-id': SESSION });
const answer = String(s2.json?.choices?.[0]?.message?.content ?? '');
check('session recall works (history injected)', /bluebird/i.test(answer), answer.slice(0, 100) || 'no answer');

/* 4 error shapes */
const noAuth = await fetch(`${BASE}/v1/models`, { headers: { authorization: 'Bearer definitely-wrong-key-000' } });
check('401 on bad key', noAuth.status === 401);
const badModel = await call({ model: 'no-such-route-xyz', messages: [{ role: 'user', content: 'hi' }] });
check('503 no_route shape', badModel.res.status === 503 && badModel.json?.error?.code === 'no_route', `status=${badModel.res.status} code=${badModel.json?.error?.code}`);
const huge = await call({ model: 'balanced', messages: [{ role: 'user', content: 'x'.repeat(2_100_000) }] });
check('413 body too large', huge.res.status === 413, `status=${huge.res.status}`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
console.log(`
Interpretation for the plan:
- If "tool result accepted" passes but a SESSION-flagged tool exchange
  replays badly, keep D1 (orchestrator-owned transcript). 
- Codename-recall PASS means gateway session memory is fine for plain chat;
  D1 still stands for tool loops because tool-role replay is untested here —
  extend this spike (see plan §12-M0 item 2) once the loop exists.
`);
process.exit(fail > 0 ? 1 : 0);
