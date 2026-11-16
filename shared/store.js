// Persistent state: seen proof_tx values + cached task responses.
// Stored on disk (JSON) so reuse is caught across restarts, not just in memory.
// Default file: data/state.json (overridable with STATE_FILE env var, e.g. for tests).
// No secrets are ever stored here — only proof_tx hashes, task_ids and responses.
const fs = require('fs');
const path = require('path');

const STATE_FILE =
  process.env.STATE_FILE || path.join(__dirname, '..', 'data', 'state.json');

function emptyState() {
  return { seenProofTx: {}, taskResponses: {} };
}

function load() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        seenProofTx: parsed.seenProofTx && typeof parsed.seenProofTx === 'object' ? parsed.seenProofTx : {},
        taskResponses: parsed.taskResponses && typeof parsed.taskResponses === 'object' ? parsed.taskResponses : {},
      };
    }
  } catch {
    // missing / corrupt file -> start empty (a corrupt file is never fatal)
  }
  return emptyState();
}

let state = load();

function save() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[store] failed to persist state:', e.message);
  }
}

function getSeenTaskId(proofTx) {
  return state.seenProofTx[String(proofTx).toLowerCase()];
}

function markSeen(proofTx, taskId) {
  const key = String(proofTx).toLowerCase();
  if (!(key in state.seenProofTx)) {
    state.seenProofTx[key] = String(taskId);
    save();
  }
}

function getCachedResponse(taskId) {
  return state.taskResponses[String(taskId)];
}

function cacheResponse(taskId, response) {
  state.taskResponses[String(taskId)] = response;
  save();
}

function reset() {
  state = emptyState();
  save();
}

function stats() {
  return {
    seenProofTxCount: Object.keys(state.seenProofTx).length,
    cachedResponsesCount: Object.keys(state.taskResponses).length,
    stateFile: STATE_FILE,
  };
}

module.exports = { load, save, getSeenTaskId, markSeen, getCachedResponse, cacheResponse, reset, stats, STATE_FILE };
