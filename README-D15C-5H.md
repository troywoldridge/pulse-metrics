# Pulse Metrics — D15C-5H Signed Audit Custody & Operator Decision Rehearsal

**Status:** REVIEW ONLY, synthetic offline test.  
**Public commercial launch:** **NO_GO**.  
**Predecessor:** verified D15C-5G checkpoint on `feat/identity-organization-onboarding`.

D15C-5H is the first cryptographic contract connecting the **frozen D15C-5G
local witness** with **separately signed synthetic operator decisions**. Two
unique ephemeral Ed25519 signing keys exercise the intended separation of
custodian and on-call roles. The verifier accepts only independently supplied
trusted public keys; the signed receipt cannot declare its own trust root.

This bundle consists of seven entirely **new** files:

- `README-D15C-5H.md`
- `docs/security/D15C-5H-SIGNED-CUSTODY-ACK-DESIGN.md`
- `scripts/telemetry-maintenance/custody-ack-contract.mjs`
- `scripts/telemetry-maintenance/custody-ack-contract.test.mjs`
- `scripts/telemetry-maintenance/custody-ack-rehearsal.mjs`
- `scripts/telemetry-maintenance/verify-custody-ack-candidate.mjs`
- `scripts/test-maintenance-signed-custody-ack-rehearsal.sh`

No existing 5A–5G code, source hashes, migrations, app grants, tenant data,
`.env`, PostgreSQL instance, real operator, external network, alert provider or
scheduled process is modified or activated.

## Security properties exercised

- Signed witness contents are bound to the entire checked D15C-5G checkpoint.
- Compromised/replaced trust keys, forged signatures and changed alert binding
  are rejected. Rewriting a valid-looking local SHA-256 chain invalidates the
  previously signed attestation.
- Operator decision is signed with a different key from the custodian.
  Verification independently rechecks the full frozen outbox snapshot digest
  and exact alert membership; a merely alert-shaped object is insufficient.
- A fresh verifier child can validate with **public keys only**.
- Replayed or stale synthetic decisions are rejected in the test's in-memory
  nonce ledger. No production-grade durable replay defense is claimed.
- An accepted synthetic decision still returns
  `automaticReplayAuthorized:false` and `realHumanAcknowledgement:false`.
- All temporary audit, outbox and witness fixture directories are restricted
  to owner and are removed after a successful rehearsal.

**Scope warning:** This is *not* actually independent custody: the keys and
files all originate under one disposable test user. No real human identity,
real custody provider, durable acknowledgement ledger, or deployment authority
is verified. See the security design file for the outstanding controls.

## Install (new paths only)

```bash
cd ~/Projects/pulse-metrics
git status -sb
unzip -l ~/Downloads/pulse-metrics-d15c5h-signed-custody-ack-review.zip
unzip -n ~/Downloads/pulse-metrics-d15c5h-signed-custody-ack-review.zip
```

`unzip -n` never overwrites existing files. Stop and inspect any unexpected
collisions. Older `README-...-FIX.md` troubleshooting notes can remain untracked.

## Review checks

```bash
cd ~/Projects/pulse-metrics
node scripts/telemetry-maintenance/verify-recovery-candidate.mjs
node scripts/telemetry-maintenance/verify-custody-ack-candidate.mjs
node --test scripts/telemetry-maintenance/custody-ack-contract.test.mjs
bash -n scripts/test-maintenance-signed-custody-ack-rehearsal.sh
bash scripts/test-maintenance-signed-custody-ack-rehearsal.sh
npm run lint
npm test
npm run build
git diff --check
git status -sb
```

Expected last rehearsal markers **only if the workstation run truly passes**:

```text
PASS: original 5D–5G audit/outbox/witness verified, interrupted send remains blocked
PASS: independently pinned synthetic custody public key validates signed frozen checkpoint
PASS: separate synthetic operator signature is alert-bound, replay-refused, and nonauthorizing
PASS: fresh verifier process received public keys only; second-use nonce rejected
PASS: source mutation/recomputed local witness rejected; no real human or external-custody claim
D15C-5H DISPOSABLE SIGNED CUSTODY AND OPERATOR-DECISION REHEARSAL PASSED
PASS: three disposable private audit, outbox and witness directories removed
========== D15C-5H OFFLINE SIGNED CUSTODY REVIEW: ALL CHECKS PASSED ==========
PUBLIC LAUNCH: NO_GO | test signatures only; no production operator or custody
```

## Exit conditions and next milestone

Do not stage/commit this review-only package until Troy's independent
workstation logs verify the source checks, unit tests, negative tests and
offline integration. Stage only the seven new files. Never automatically
retry ambiguous deliveries or claim transport acceptance means a person
acknowledged an alert.

After this reviewed milestone, separately design a **durable acknowledged
replay ledger and externally controlled custody integration**. Both require
real provider choices and independently authorized security review; 5H alone
is not production readiness.
