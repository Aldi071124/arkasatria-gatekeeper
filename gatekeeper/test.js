// Gatekeeper test harness — replays sample envelopes for ALL 7 trap types
// plus boundary cases, and checks each decision against the circuit itself:
// a case passes only if (a) decide() returns the expected decision/reason_code
// AND (b) a Groth16 proof generated for that decision verifies locally
// (except PROOF_REUSED, which by design carries no proof).
// HTTP-level cases cover: same task_id retry (idempotent, identical cached
// response), bad HMAC (401), and a malformed task (REJECT / INVALID_TASK).
// Uses an isolated state file (never the production data/state.json).
// Run:  node gatekeeper/test.js   (or: npm test)
process.env.STATE_FILE = require('path').join(__dirname, '..', 'data', 'test-state.json');
process.env.AGENT_GAMES_HMAC_SECRET = 'test-secret-only-for-local-tests';

const crypto = require('crypto');
const http = require('http');
const { decide } = require('./decide');
const { proveTask } = require('./prove');
const { verifyLocally } = require('../shared/snark');
const store = require('../shared/store');
const { server } = require('../server');
const { signatureFor } = require('../shared/hmac');

const VK = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const OTHER_VK = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR = '0x1111111111111111111111111111111111111111';
const OTHER_ADDR = '0x2222222222222222222222222222222222222222';

function base(overrides = {}) {
  return Object.assign({
    task_id: 'gk_test_1', registered_vk: VK, proof_vk: VK,
    minimum: '1000', public_balance: '1460', expiry_block: '8430000', current_block: '8420000',
    recipient: ADDR, condition_recipient: ADDR,
    amount: '500', max_transfer: '1000', proof_tx: '0xtestproof1',
  }, overrides);
}

function envelope(task) {
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: task.task_id,
    mode: 'competition',
    issued_at: '2026-11-16T00:00:00Z',
    deadline_at: '2026-11-16T00:01:00Z',
    input: task,
  };
}

const CASES = [
  ['VALID_CONDITION (APPROVE)', base(), 'APPROVE', 'VALID_CONDITION', true],
  ['VK_SUBSTITUTION', base({ proof_vk: OTHER_VK, proof_tx: '0xtestproof2' }), 'REJECT', 'VK_SUBSTITUTION', true],
  ['THRESHOLD_MISMATCH (balance 999 < 1000)', base({ public_balance: '999', proof_tx: '0xtestproof3' }), 'REJECT', 'THRESHOLD_MISMATCH', true],
  ['EXPIRED_CONDITION (current 8430001 > expiry 8430000)', base({ current_block: '8430001', proof_tx: '0xtestproof4' }), 'REJECT', 'EXPIRED_CONDITION', true],
  ['RECIPIENT_MISMATCH', base({ recipient: OTHER_ADDR, proof_tx: '0xtestproof5' }), 'REJECT', 'RECIPIENT_MISMATCH', true],
  ['AMOUNT_OVERFLOW (1500 > 1000)', base({ amount: '1500', proof_tx: '0xtestproof6' }), 'REJECT', 'AMOUNT_OVERFLOW', true],
  // boundaries (inclusive except expiry, which is strict)
  ['boundary: balance == minimum (1000)', base({ public_balance: '1000', proof_tx: '0xtestproof7' }), 'APPROVE', 'VALID_CONDITION', true],
  ['boundary: current == expiry (8430000) -> EXPIRED (strict)', base({ current_block: '8430000', proof_tx: '0xtestproof8' }), 'REJECT', 'EXPIRED_CONDITION', true],
  ['boundary: current == expiry - 1 (8429999)', base({ current_block: '8429999', proof_tx: '0xtestproof8b' }), 'APPROVE', 'VALID_CONDITION', true],
  ['boundary: amount == max (1000)', base({ amount: '1000', proof_tx: '0xtestproof9' }), 'APPROVE', 'VALID_CONDITION', true],
];

function post(port, path, body, sign) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json' };
    if (sign !== null) headers['x-agent-games-signature'] = signatureFor(sign, raw, 'hex');
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(raw);
  });
}

(async () => {
  store.reset();
  let pass = 0;
  let total = 0;
  let approveProofMs = null;

  for (const [name, task, wantDecision, wantReason, withProof] of CASES) {
    total++;
    const t0 = Date.now();
    const got = decide(task);
    const decisionOk = got.decision === wantDecision && got.reason_code === wantReason;
    let proofOk = false;
    let proofMs = 0;
    try {
      const { proof, publicSignals } = await proveTask(task, got.decision, 'keccak');
      proofMs = Date.now() - t0;
      proofOk = await verifyLocally('gatekeeper', publicSignals, proof);
      if (wantDecision === 'APPROVE' && wantReason === 'VALID_CONDITION' && approveProofMs === null) approveProofMs = proofMs;
    } catch (e) {
      proofOk = false;
    }
    const ok = decisionOk && (withProof ? proofOk : true);
    if (ok) pass++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  decision=${got.decision}/${got.reason_code} (want ${wantDecision}/${wantReason})  proof=${proofOk ? 'verify OK' : 'FAIL'}  ${proofMs}ms`);
  }

  // PROOF_REUSED: same proof_tx, different task_id (after the valid case used 0xtestproof1)
  total++;
  const reuse = base({ task_id: 'gk_test_99', proof_tx: '0xtestproof1' });
  const r = decide(reuse);
  const reuseOk = r.decision === 'REJECT' && r.reason_code === 'PROOF_REUSED';
  if (reuseOk) pass++;
  console.log(`${reuseOk ? 'PASS' : 'FAIL'}  PROOF_REUSED (same proof_tx, other task_id)  decision=${r.decision}/${r.reason_code}`);

  // ---- HTTP-level cases (live server, ephemeral port, test HMAC secret) ----
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const SECRET = process.env.AGENT_GAMES_HMAC_SECRET;

  // same task_id retry is NOT a reuse: identical cached response
  total++;
  const env = envelope(base({ task_id: 'gk_http_1', proof_tx: '0xhttpproof1' }));
  const first = await post(port, '/gatekeeper', env, SECRET);
  const second = await post(port, '/gatekeeper', env, SECRET);
  const firstBody = JSON.parse(first.body);
  const retryOk = first.status === 200 && second.status === 200
    && first.body === second.body
    && firstBody.decision === 'APPROVE' && firstBody.reason_code === 'VALID_CONDITION'
    && Array.isArray(firstBody.public_signals) && firstBody.public_signals.length === 13
    && !!second.headers['x-agent-games-signature'];
  if (retryOk) pass++;
  console.log(`${retryOk ? 'PASS' : 'FAIL'}  HTTP same task_id retry: identical cached response, signed, 13 public signals  (status ${first.status}/${second.status})`);

  // bad HMAC -> 401, no work done
  total++;
  const bad = await post(port, '/gatekeeper', env, 'wrong-secret');
  const badOk = bad.status === 401;
  if (badOk) pass++;
  console.log(`${badOk ? 'PASS' : 'FAIL'}  HTTP bad HMAC -> 401  (status ${bad.status})`);

  // malformed task -> REJECT / INVALID_TASK (fail closed, no crash)
  total++;
  const malformed = await post(port, '/gatekeeper', { type: 'agent-games.proof-gatekeeper.v1', task_id: 'gk_http_bad', input: { registered_vk: VK } }, SECRET);
  let malformedOk = false;
  try {
    const m = JSON.parse(malformed.body);
    malformedOk = malformed.status === 200 && m.decision === 'REJECT' && m.reason_code === 'INVALID_TASK';
  } catch { malformedOk = false; }
  if (malformedOk) pass++;
  console.log(`${malformedOk ? 'PASS' : 'FAIL'}  HTTP malformed task -> REJECT/INVALID_TASK  (status ${malformed.status})`);

  server.close();

  console.log(`\nVALID APPROVE proof generation time: ${approveProofMs}ms (60s deadline)`);
  console.log(`${pass}/${total} gatekeeper cases passed`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
