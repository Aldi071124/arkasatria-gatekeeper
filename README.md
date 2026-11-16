# arkasatria — Proof Gatekeeper agent for zkVerify Agent Games Season 01

Agent name: **arkasatria**
Operator: Aldi (X [@Arkasatria_137](https://x.com/Arkasatria_137))
Prize wallet (public address only — this code never signs with it, never asks
for its private key, and never connects any wallet):
`0x82bE90310351c6dD29d5bbd4b9eFF86729017f06`

Tournament: zkVerify Agent Games, Season 01 — 21 Oct – 21 Nov 2026.
Track: **Proof Gatekeeper** (100,000 VFY per track: 1st 50,000 / 2nd 30,000 /
3rd 20,000). Rounds: 8 daily scored rounds, 13–21 Nov 2026, 4:00 PM–2:00 AM
IST (17:30–03:30 WIB), 8 tasks per agent per round. Round 04 opens 16 Nov.
Competition closes 21 Nov 2026, 22:00 UTC; judgement 22–30 Nov.

## What this agent does

The platform POSTs a signed task envelope to `POST /gatekeeper`. The agent
verifies the HMAC signature over the raw body, decides deterministically
(APPROVE / REJECT), generates a Groth16 proof of that decision with the
official gatekeeper circuit (locally, with snarkjs), and returns the signed
response — all within the 60-second hard deadline (proofs take ~0.3s).

Decision checklist, first failing trap wins (boundaries verified against the
circuit):

| Check | Failing case | reason_code |
|---|---|---|
| proof VK == registered VK | different VK | `VK_SUBSTITUTION` |
| proof_tx not seen under another task_id | reused proof | `PROOF_REUSED` (no proof attached) |
| public_balance >= minimum | balance below minimum | `THRESHOLD_MISMATCH` |
| current_block < expiry_block (STRICT) | current >= expiry | `EXPIRED_CONDITION` |
| recipient == condition_recipient | different address | `RECIPIENT_MISMATCH` |
| amount <= max_transfer | amount over cap | `AMOUNT_OVERFLOW` |
| all pass | — | `VALID_CONDITION` → APPROVE |

Boundaries: `balance == minimum` and `amount == max_transfer` are VALID;
`current_block == expiry_block` is EXPIRED. A retry of the same `task_id`
returns the identical cached response and is NOT a reuse. Any malformed task
or uncertainty → REJECT (`INVALID_TASK` if fields are missing/unparseable),
never approve by default. Scoring: correct +12, wrong APPROVE −6, wrong
REJECT −3, timeout −2, missing/invalid proof −2, reliability bonus +0..+5
(PROOF_REUSED tasks are excluded from the bonus).

Circuit inputs used (exact signal names): `registeredVkHash`,
`proofVkHash`, `minimum`, `publicBalance`, `expiryBlock`, `currentBlock`,
`recipient`, `conditionRecipient`, `amount`, `maxTransfer`, `decision`
(1 = APPROVE, 0 = REJECT), `taskId`, `salt` (private). Public signals (13):
`[hash, registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
currentBlock, recipient, conditionRecipient, amount, maxTransfer, decision,
taskId]`. `taskId` mapping (default, `keccak`): `keccak256(task_id as UTF-8)
mod FIELD_PRIME`; alternatives `numeric` / `hex` via
`GATEKEEPER_TASK_ID_MODE` — this mapping is **unconfirmed against the
platform** and must be checked with a practice task; if the platform rejects
the proof, switch the mode and retry. Official circuit vkHash:
`0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
(`https://agentgames.zkverify.io/api/circuit-info`).

## Run locally

```bash
npm install
cp .env.example .env   # then fill in AGENT_GAMES_HMAC_SECRET (see below)
node server.js         # listens on PORT (default 8080)
npm test               # test harness — see "Tests" below
```

No `.env` is needed for local tests: `npm test` uses its own test-only HMAC
secret and an isolated state file (`data/test-state.json`).

Environment variables:

| Variable | Required | What it is |
|---|---|---|
| `PORT` | no (8080) | Local port |
| `AGENT_GAMES_HMAC_SECRET` | **yes, before going live** | 32-byte secret issued once by the dashboard ("Rotate Secret"). Read only from the environment / `.env`. Never hardcode, never commit, never paste into chat or an AI tool. Without it, inbound HMAC verification is disabled (health shows it). |
| `AGENT_GAMES_HMAC_FORMAT` | no (`hex`) | `hex` or `sha256=` — switch if the platform rejects the preflight |
| `GATEKEEPER_TASK_ID_MODE` | no (`keccak`) | `keccak` (default), `numeric`, `hex` — see taskId note above |
| `STATE_FILE` | no (`data/state.json`) | Where seen proof_tx values + cached responses persist |

Endpoints: `POST /gatekeeper`, `GET /health` (readiness: HMAC configured?,
self-test result, state counts), `GET /` (info). Preflight
`{"type":"agent-games.preflight.v1"}` is answered
`{ok:true, protocolVersion:"v1"}`, signed with `x-agent-games-signature`
over the raw response body — an unsigned response fails preflight.

## Tests

`npm test` — 14/14 passing (measured 2026-11-16):

- All 7 trap types + valid condition, each with a real Groth16 proof that
  verifies locally against the exported verification key.
- Boundaries: balance == minimum (APPROVE), current == expiry (EXPIRED),
  current == expiry − 1 (APPROVE), amount == max (APPROVE).
- PROOF_REUSED (same proof_tx, different task_id) — decision only, no proof.
- HTTP level: same task_id retry returns the identical signed cached
  response with 13 public signals; bad HMAC → 401; malformed task →
  REJECT / `INVALID_TASK`.

Proof generation: first proof in a fresh process ~994 ms (includes WASM
load), subsequent proofs ~230–350 ms; live server round-trip for a valid
APPROVE task was 279 ms — far inside the 60 s deadline. Circuit files
verified by size: `circuits/gatekeeper.wasm` 1,755,820 bytes,
`circuits/gatekeeper_final.zkey` 309,750 bytes.

## Deploy (Railway from a public GitHub repo — the known working path)

1. Push this folder to a **public** GitHub repo (from Aldi's GitHub account —
   the same account he links in the dashboard; see "Still blocked" below).
   Do NOT commit `.env`, `node_modules/`, or `data/state.json` (`.gitignore`
   already excludes them).
2. In Railway, create a project from that repo (Node.js). Set the env vars
   from `.env.example` — above all `AGENT_GAMES_HMAC_SECRET` from the
   dashboard. Use a paid/always-on plan if possible: free-tier services that
   sleep after inactivity will miss tasks, and the platform forfeits tasks
   delivered while the agent is offline.
3. Note the public HTTPS URL Railway gives the service (no custom ports).
   The registered endpoint is `https://<your-railway-host>/gatekeeper`.
4. Restart the service after setting env vars. Check `GET /health`: it
   must show `hmacConfigured: true` and
   `selfTest: "PASS (APPROVE proof verifies locally)"`.

**Tunnel caveat (measured 2026-11-16):** from the VM this code was built
on, no public tunnel worked — `api.trycloudflare.com` returns 403 and
localtunnel produced no URL within 40 s. Do not rely on a tunnel from that
VM; deploy on Railway (or another host with unrestricted egress) instead.

## Registration + preflight (Aldi does this in his own browser)

This repo does NOT register anything and cannot: registration needs Aldi's
own sign-in.

1. Go to https://agentgames.zkverify.io and click **Register an agent**.
2. Sign in with X or with a wallet (SIWE — Sign-In With Ethereum). The
   wallet signs the message *"Sign in to Agent Games with your wallet."*
   (chain ID 1, 5-minute expiry). It costs nothing — no transaction, no gas,
   no funds moved. The wallet must be able to produce an EIP-191 personal
   signature; some managed/agent wallets that only do EIP-712 typed-data
   signatures cannot complete this login. **Never paste a private key or
   seed anywhere — signing happens in Aldi's own wallet/browser only.**
3. Complete the profile: agent name **arkasatria**, prize wallet
   `0x82bE90310351c6dD29d5bbd4b9eFF86729017f06`, link his GitHub account
   (required for prize eligibility; one GitHub account per competition
   account, one agent per owner).
4. Register the endpoint URL (`https://<host>/gatekeeper`) in the dashboard.
5. **Rotate Secret** in the dashboard → the platform shows a 32-byte secret
   exactly once. Copy it into the deployment's
   `AGENT_GAMES_HMAC_SECRET` env var and restart the server. If it is lost
   or compromised, rotate it again from the dashboard (the old secret stops
   working immediately).
6. Run the dashboard **preflight** (signed `agent-games.preflight.v1`) and
   at least one **practice task** (practice mode: same format as scored
   tasks, no leaderboard effect, capped at 10 dispatches per active agent
   per hour). This is the step that confirms the HMAC format and the
   `taskId` mapping — if the practice proof is rejected, switch
   `AGENT_GAMES_HMAC_FORMAT` / `GATEKEEPER_TASK_ID_MODE` and retry.
7. Only then enter the scored rounds. Entries lock while a round is open.

## Still blocked on Aldi

- **SIWE sign-in** on agentgames.zkverify.io with his wallet, in his own
  browser (Kit cannot sign for him and must never receive his private key).
- **GitHub account link** in the dashboard (required for prize eligibility).
- **Choice of hosting account** (Railway account / GitHub repo under his
  account) and pushing this code there.
- **The dashboard-issued HMAC secret** — it is generated at registration
  and shown once; it must be set as `AGENT_GAMES_HMAC_SECRET` on the host.
- **Preflight + practice task** confirmation (HMAC format + taskId mapping).

Until those are done, the agent is **not registered, not healthy on the
platform, and not entered in any round** — no matter that the server works
locally.

## Files

```
server.js                  entry point (Node.js stdlib http only)
gatekeeper/decide.js       7-trap checklist (+ persistent seen-set)
gatekeeper/prove.js        circuit input mapping, taskId mapping
gatekeeper/test.js         harness: 14 cases (traps, boundaries, HTTP)
shared/field.js            field arithmetic, keccak
shared/hmac.js             HMAC-SHA256 verify/sign
shared/snark.js            snarkjs wrapper (prove / verify)
shared/store.js            disk persistence (seen proof_tx + cached responses)
circuits/                  official gatekeeper wasm + zkey — NOT committed
                           (binary files); `npm install` downloads them from
                           https://agentgames.zkverify.io/circuits/ via
                           `scripts/fetch-circuits.js` (postinstall, sizes
                           verified: wasm 1,755,820 bytes, zkey 309,750 bytes)
data/                      state.json (runtime; gitignored) + .gitkeep
.env.example               env vars (no real secrets)
.gitignore                 node_modules/, .env, data/state.json
package.json               snarkjs 0.7.6, js-sha3
```

## Security notes

- No wallet, private key, seed, or signing happens anywhere in this code.
- The HMAC secret is the only credential; it lives only in the environment.
- Every inbound request is HMAC-verified over the raw body before parsing;
  every response is signed the same way (constant-time compare, 401 on
  mismatch, no work done).
- Seen proof_tx values and task responses persist to `data/state.json`
  (atomic write via temp file + rename) so reuse is caught across restarts.
