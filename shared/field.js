// Shared helpers: field-element conversion + keccak.
// BN128 (alt_bn128) prime field — the field of the Agent Games gatekeeper circuit.
const { keccak_256 } = require('js-sha3');

const FIELD_PRIME = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

function toField(x) {
  let b;
  if (typeof x === 'bigint') b = x;
  else if (typeof x === 'number') b = BigInt(x);
  else if (typeof x === 'string' && x.startsWith('0x')) b = BigInt(x);
  else b = BigInt(x);
  const r = b % FIELD_PRIME;
  return r < 0n ? r + FIELD_PRIME : r;
}

function to32Bytes(x) {
  const b = toField(x);
  return Buffer.from(b.toString(16).padStart(64, '0'), 'hex');
}

function keccak256Hex(buffers) {
  return '0x' + keccak_256(Buffer.concat(buffers));
}

function keccak256ModP(buffers) {
  return toField(BigInt(keccak256Hex(buffers)));
}

module.exports = { FIELD_PRIME, toField, to32Bytes, keccak256Hex, keccak256ModP };
