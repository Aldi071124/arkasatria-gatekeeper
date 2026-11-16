// Proof Gatekeeper — deterministic 7-trap decision logic.
// The circuit itself is the referee: it enforces that the decision matches the
// correct evaluation of the inputs (a wrong decision fails witness generation).
// This module must therefore implement EXACTLY the circuit's checks.
//
// Checks (first failing trap wins; reason_code = trap name):
//   VK_SUBSTITUTION   proof_vk != registered_vk
//   PROOF_REUSED      proof_tx already seen under a DIFFERENT task_id
//   THRESHOLD_MISMATCH public_balance < minimum
//   EXPIRED_CONDITION current_block >= expiry_block (STRICT: == is expired)
//   RECIPIENT_MISMATCH recipient != condition_recipient (case-insensitive)
//   AMOUNT_OVERFLOW   amount > max_transfer
//   else VALID_CONDITION -> APPROVE
//
// Boundary notes (verified against the circuit):
//   - public_balance == minimum is VALID (threshold is inclusive).
//   - current_block == expiry_block is EXPIRED (valid only while current < expiry).
//   - amount == max_transfer is VALID (max is inclusive).
//   - proof_tx reuse is tracked per task_id: a platform retry of the SAME
//     task_id is not a reuse; the same proof_tx under another task_id is.
//   - A VK_SUBSTITUTION failure does NOT consume the proof_tx (the proof
//     never belonged to this condition in the first place).
//
// Seen proof_tx values are persisted to disk via shared/store.js so reuse is
// caught across restarts. decide() is pure except for that persistence.
const store = require('../shared/store');

function normalizeAddress(a) {
  return String(a || '').toLowerCase();
}

function decide(input) {
  const taskId = String(input.task_id || '');
  const registeredVk = String(input.registered_vk || '').toLowerCase();
  const proofVk = String(input.proof_vk || '').toLowerCase();
  const minimum = BigInt(input.minimum);
  const publicBalance = BigInt(input.public_balance);
  const expiryBlock = BigInt(input.expiry_block);
  const currentBlock = BigInt(input.current_block);
  const recipient = normalizeAddress(input.recipient);
  const conditionRecipient = normalizeAddress(input.condition_recipient);
  const amount = BigInt(input.amount);
  const maxTransfer = BigInt(input.max_transfer);
  const proofTx = String(input.proof_tx || '').toLowerCase();

  if (proofVk !== registeredVk) return { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION' };

  if (proofTx) {
    const prevTask = store.getSeenTaskId(proofTx);
    if (prevTask !== undefined && prevTask !== taskId) {
      return { decision: 'REJECT', reason_code: 'PROOF_REUSED' };
    }
    if (prevTask === undefined) store.markSeen(proofTx, taskId);
  }

  if (publicBalance < minimum) return { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' };
  // STRICT expiry: valid only while current_block < expiry_block.
  if (currentBlock >= expiryBlock) return { decision: 'REJECT', reason_code: 'EXPIRED_CONDITION' };
  if (recipient !== conditionRecipient) return { decision: 'REJECT', reason_code: 'RECIPIENT_MISMATCH' };
  if (amount > maxTransfer) return { decision: 'REJECT', reason_code: 'AMOUNT_OVERFLOW' };

  return { decision: 'APPROVE', reason_code: 'VALID_CONDITION' };
}

module.exports = { decide };
