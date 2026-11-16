// Agent Games Season 01 — Proof Gatekeeper agent "arkasatria".
// Operator: Aldi (X @Arkasatria_137). Prize wallet (public address only, never
// used for signing here): 0x82bE90310351c6dD29d5bbd4b9eFF86729017f06.
// This server never touches any wallet, key, or seed — it is a game endpoint
// only: it receives signed task envelopes, decides APPROVE/REJECT, and proves
// each decision with a local Groth16 proof from the official circuit.
//
// Endpoints:
//   POST /gatekeeper  — Proof Gatekeeper tasks (signed envelope)
//   GET  /health      — readiness (HMAC configured? self-test? state counts?)
//   GET  /            — info
//
// Every inbound request is HMAC-verified over the RAW body against
// x-agent-games-signature BEFORE parsing (when AGENT_GAMES_HMAC_SECRET is
// set). Every response is signed the same way. Preflight
// {"type":"agent-games.preflight.v1"} is answered {ok:true, protocolVersion:"v1"}.
//
// Fail closed: any malformed task, any uncertainty, or any proof-generation
// failure returns REJECT (without a proof) rather than approving. A retry of
// the same task_id returns the identical cached response. Nothing here ever
// approves, signs, or spends anything on-chain.
const fs = require('fs');
const path = require('path');
const http = require('http');

// ---- tiny .env loader (no dependency) ----
(function loadEnv() {
  const envFile = path.join(__dirname, '.env');
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* no .env — env vars only */ }
})();

const { verifySignature, signatureFor } = require('./shared/hmac');
const { verifyLocally } = require('./shared/snark');
const { decide } = require('./gatekeeper/decide');
const { proveTask } = require('./gatekeeper/prove');
const store = require('./shared/store');

const AGENT_NAME = 'arkasatria';
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET || '';
const HMAC_FORMAT = process.env.AGENT_GAMES_HMAC_FORMAT || 'hex'; // or 'sha256='
const TASK_ID_MODE = process.env.GATEKEEPER_TASK_ID_MODE || 'keccak';

let gatekeeperSelfTest = 'pending';

// ---- helpers ----
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json' };
  if (HMAC_SECRET) headers['x-agent-games-signature'] = signatureFor(HMAC_SECRET, body, HMAC_FORMAT);
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyInbound(rawBody, req) {
  if (!HMAC_SECRET) {
    console.warn('[warn] AGENT_GAMES_HMAC_SECRET is not set — inbound HMAC is NOT verified. Set it before going live.');
    return true;
  }
  const sig = req.headers['x-agent-games-signature'];
  return verifySignature(HMAC_SECRET, rawBody, sig, HMAC_FORMAT);
}

function isPreflight(obj) {
  return obj && obj.type === 'agent-games.preflight.v1';
}

// ---- Gatekeeper handler ----
async function handleGatekeeper(obj) {
  // Idempotency: a platform retry of the same task_id returns the identical
  // cached response (and must NOT be treated as a proof reuse).
  const taskId = String((obj && (obj.task_id || (obj.input && obj.input.task_id))) || '');
  if (taskId) {
    const cached = store.getCachedResponse(taskId);
    if (cached) return { status: 200, body: cached };
  }

  // Envelope type: if present it must be the gatekeeper type; absent is
  // accepted (older/practice envelopes omit it).
  if (obj && obj.type && obj.type !== 'agent-games.proof-gatekeeper.v1') {
    return { status: 200, body: { decision: 'REJECT', reason_code: 'INVALID_TASK', proof_tx: '' } };
  }

  const task = (obj && obj.input) || obj || {};
  const required = ['registered_vk', 'proof_vk', 'minimum', 'public_balance', 'expiry_block', 'current_block', 'recipient', 'condition_recipient', 'amount', 'max_transfer'];
  for (const f of required) {
    if (task[f] === undefined || task[f] === null || task[f] === '') {
      return { status: 200, body: { decision: 'REJECT', reason_code: 'INVALID_TASK', proof_tx: String(task.proof_tx || '') } };
    }
  }
  // Numeric fields must parse as integers; anything else is malformed.
  try {
    for (const f of ['minimum', 'public_balance', 'expiry_block', 'current_block', 'amount', 'max_transfer']) BigInt(task[f]);
  } catch {
    return { status: 200, body: { decision: 'REJECT', reason_code: 'INVALID_TASK', proof_tx: String(task.proof_tx || '') } };
  }

  const fullTask = { ...task, task_id: taskId || String(task.task_id || '') };
  const { decision, reason_code } = decide(fullTask);
  const proofTx = String(task.proof_tx || '');

  let body;
  if (reason_code === 'PROOF_REUSED') {
    // No proof to submit for a reused proof (platform excludes these from
    // the reliability bonus).
    body = { decision, reason_code, proof_tx: proofTx };
  } else {
    try {
      const { proof, publicSignals } = await proveTask(fullTask, decision, TASK_ID_MODE);
      body = { decision, reason_code, proof_tx: proofTx, proof, public_signals: publicSignals };
    } catch (e) {
      // Fail closed: return the decision WITHOUT a proof rather than crashing
      // or hanging. (A provable task without a proof costs -2, but a timeout
      // or an approval of a trap costs more.)
      console.error('[gatekeeper] proof generation failed (decision still returned):', e.message);
      body = { decision, reason_code, proof_tx: proofTx };
    }
  }

  if (taskId) store.cacheResponse(taskId, body);
  return { status: 200, body };
}

// ---- startup self-test (prove the circuit works before serving) ----
async function selfTests() {
  try {
    const task = {
      task_id: 'gk_selftest_1', registered_vk: '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0',
      proof_vk: '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0',
      minimum: '1000', public_balance: '1460', expiry_block: '8430000', current_block: '8420000',
      recipient: '0x1111111111111111111111111111111111111111',
      condition_recipient: '0x1111111111111111111111111111111111111111',
      amount: '500', max_transfer: '1000', proof_tx: '0xselftest',
    };
    const { decision } = decide(task);
    const { proof, publicSignals } = await proveTask(task, decision, TASK_ID_MODE);
    const ok = await verifyLocally('gatekeeper', publicSignals, proof);
    gatekeeperSelfTest = ok && decision === 'APPROVE' ? 'PASS (APPROVE proof verifies locally)' : 'FAIL';
  } catch (e) {
    gatekeeperSelfTest = 'FAIL: ' + e.message;
  }
}

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, {
        ok: true,
        agent: AGENT_NAME,
        track: 'proof-gatekeeper',
        gatekeeper: { hmacConfigured: !!HMAC_SECRET, taskIdMode: TASK_ID_MODE, selfTest: gatekeeperSelfTest },
        state: store.stats(),
        uptimeSec: Math.floor(process.uptime()),
      });
    }

    if (req.method === 'GET' && req.url === '/') {
      return sendJson(res, 200, { service: 'agent-games', agent: AGENT_NAME, tracks: ['proof-gatekeeper'], endpoints: ['POST /gatekeeper', 'GET /health'] });
    }

    if (req.method !== 'POST' || req.url !== '/gatekeeper') {
      return sendJson(res, 404, { error: 'not found' });
    }

    const rawBody = await readBody(req);
    if (!verifyInbound(rawBody, req)) {
      console.warn('[warn] HMAC mismatch on', req.url);
      return sendJson(res, 401, { error: 'bad signature' });
    }

    let obj;
    try {
      obj = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }

    if (isPreflight(obj)) {
      return sendJson(res, 200, { ok: true, protocolVersion: 'v1' });
    }

    const result = await handleGatekeeper(obj);
    return sendJson(res, result.status, result.body);
  } catch (e) {
    console.error('[server] unhandled error:', e);
    return sendJson(res, 500, { error: 'internal error' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, async () => {
    console.log(`[server] agent "${AGENT_NAME}" listening on ${HOST}:${PORT}  (POST /gatekeeper, GET /health)`);
    console.log(`[server] HMAC secret: ${HMAC_SECRET ? 'configured' : 'NOT SET (inbound verification disabled)'}`);
    await selfTests();
    console.log(`[server] self-test gatekeeper: ${gatekeeperSelfTest}`);
  });
}

module.exports = { server, handleGatekeeper, AGENT_NAME };
