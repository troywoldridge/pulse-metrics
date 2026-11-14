/**
 * Pulse Metrics D15C-5H: OFFLINE synthetic signature verification contract.
 * Separate ephemeral Ed25519 keys are used solely to exercise trust boundaries.
 * NO real custody, workload principal, role authorization, human identity,
 * notification, replay permission, database access, or production capability.
 */
import { createHash, sign, verify } from 'node:crypto';

const HEX = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const EXACT = (o, keys) => o !== null && typeof o === 'object' &&
  !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype &&
  Object.keys(o).sort().join('|') === [...keys].sort().join('|');
const sha = x => createHash('sha256').update(x).digest('hex');
const bodyString = o => JSON.stringify(o);
const goodTime = s => typeof s === 'string' && ISO.test(s) &&
  Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const validTime = (s, now, maxAge) => goodTime(s) && Number.isFinite(now) &&
  Date.parse(s) <= now + 30000 && now - Date.parse(s) <= maxAge;
const pureKey = (key, type) => key?.type === type && key?.asymmetricKeyType === 'ed25519';
const keyId = key => sha(key.export({format:'der',type:'spki'}));
const signed = (body, privateKey) => sign(null, Buffer.from(bodyString(body)), privateKey).toString('base64url');
const verifySignature = (body, sig, publicKey) => {
  try {
    if (!pureKey(publicKey,'public') || typeof sig !== 'string' || !SIG.test(sig)) return false;
    const b = Buffer.from(sig,'base64url');
    return b.length === 64 && b.toString('base64url') === sig &&
      verify(null, Buffer.from(bodyString(body)), publicKey, b);
  } catch { return false; }
};
const attestationKeys = ['schema','issuer','keyId','witnessHash','auditHead',
  'auditSequence','outboxHash','outboxCount','missingOutbox','issuedAt','nonce','signature'];
const ackKeys = ['schema','operator','keyId','attestationHash','alertKey','auditHash',
  'auditSequence','decision','issuedAt','nonce','signature'];
export const CUSTODY_ACK = Object.freeze({
  schema: 'pulse-synthetic-custody-attestation/v1',
  ackSchema: 'pulse-synthetic-operator-decision/v1',
  issuer: 'disposable_custodian', operator: 'disposable_oncall',
  liveDelivery: false, realHumanAcknowledgement: false,
  externalCustodyVerified: false, automaticReplayAuthorized: false,
  productionAuthorized: false, publicLaunch: 'NO_GO',
});
// Local 5G witness is already validated by readFrozenWitness. The field
// equality check prevents silently accepting an arbitrary replacement shape.
function validWitness(w) {
  return EXACT(w, ['schema','auditSequence','auditHead','outboxCount',
    'outboxHash','missingOutbox','createdAt','hash']) &&
    w.schema === 'pulse-local-alert-witness/v1' &&
    Number.isSafeInteger(w.auditSequence) && w.auditSequence >= 0 && w.auditSequence <= 2048 &&
    HEX.test(w.auditHead) && HEX.test(w.outboxHash) && HEX.test(w.hash) &&
    Number.isSafeInteger(w.outboxCount) && w.outboxCount >= 0 && w.outboxCount <= 32 &&
    Number.isSafeInteger(w.missingOutbox) && w.missingOutbox >= 0 && w.missingOutbox <= 2048 &&
    goodTime(w.createdAt) && sha(bodyString((({hash,...body})=>body)(w))) === w.hash;
}
const attBody = ({signature,...rest}) => rest;
export function createSyntheticCustodyAttestation(witness, privateKey, publicKey, nonce, now = new Date()) {
  if (!validWitness(witness) || !pureKey(privateKey,'private') ||
      !pureKey(publicKey,'public') || !NONCE.test(nonce) ||
      !validTime(now?.toISOString?.(),Date.now(),30000)) throw Error('synthetic_custody_refused');
  const body = {schema:CUSTODY_ACK.schema, issuer:CUSTODY_ACK.issuer,
    keyId:keyId(publicKey), witnessHash:witness.hash,
    auditHead:witness.auditHead,auditSequence:witness.auditSequence,
    outboxHash:witness.outboxHash,outboxCount:witness.outboxCount,
    missingOutbox:witness.missingOutbox,issuedAt:now.toISOString(),nonce};
  const result = {...body,signature:signed(body,privateKey)};
  if (!verifySyntheticCustodyAttestation(result, witness, publicKey,now.getTime()))
    throw Error('synthetic_custody_refused');
  return result;
}
export function verifySyntheticCustodyAttestation(a, witness, trustedCustodianKey, now = Date.now()) {
  if (!EXACT(a, attestationKeys) || !validWitness(witness) ||
      !pureKey(trustedCustodianKey,'public') ||
      a.schema !== CUSTODY_ACK.schema || a.issuer !== CUSTODY_ACK.issuer ||
      a.keyId !== keyId(trustedCustodianKey) || a.witnessHash !== witness.hash ||
      a.auditHead !== witness.auditHead || a.auditSequence !== witness.auditSequence ||
      a.outboxHash !== witness.outboxHash || a.outboxCount !== witness.outboxCount ||
      a.missingOutbox !== witness.missingOutbox || !NONCE.test(a.nonce) ||
      !validTime(a.issuedAt,now,7*86400000)) return false;
  return verifySignature(attBody(a),a.signature,trustedCustodianKey);
}
function validAlert(r) {
  return EXACT(r, ['key','auditHash','auditSequence','code','severity',
    'status','attempts','lastOutcome']) && HEX.test(r.key) && HEX.test(r.auditHash) &&
    Number.isSafeInteger(r.auditSequence) && r.auditSequence >= 1 && r.auditSequence <= 2048 &&
    ['maintenance_possible_backlog','maintenance_operation_failed',
      'maintenance_configuration_denied','maintenance_protocol_invalid'].includes(r.code) &&
    r.severity === (r.code === 'maintenance_possible_backlog' ? 'warning' : 'critical') &&
    ['pending','in_flight','retry_pending','transport_accepted',
      'receiver_duplicate','dead_letter'].includes(r.status) &&
    Number.isSafeInteger(r.attempts) && r.attempts >= 0 && r.attempts <= 3 &&
    (r.lastOutcome === null || ['retryable','transport_accepted','receiver_duplicate',
      'permanent_failure','protocol_invalid'].includes(r.lastOutcome));
}
export function createSyntheticOperatorDecision(a, witness, custodianPublicKey,
  alert, operatorPrivateKey, operatorPublicKey, decision, nonce, now = new Date()) {
  if (!verifySyntheticCustodyAttestation(a,witness,custodianPublicKey,now.getTime()) ||
      !validAlert(alert) || !pureKey(operatorPrivateKey,'private') ||
      !pureKey(operatorPublicKey,'public') ||
      !['escalate_no_replay','review_no_replay'].includes(decision) ||
      !NONCE.test(nonce) || !validTime(now?.toISOString?.(),Date.now(),30000))
    throw Error('synthetic_operator_refused');
  const body={schema:CUSTODY_ACK.ackSchema,operator:CUSTODY_ACK.operator,
    keyId:keyId(operatorPublicKey),attestationHash:sha(bodyString(a)),
    alertKey:alert.key,auditHash:alert.auditHash,auditSequence:alert.auditSequence,
    decision,issuedAt:now.toISOString(),nonce};
  const result={...body,signature:signed(body,operatorPrivateKey)};
  if (!verifySyntheticOperatorDecision(result,a,witness,custodianPublicKey,
      alert,operatorPublicKey,new Set(),now.getTime()).accepted)
    throw Error('synthetic_operator_refused');
  return result;
}
// Replay ledger represents an explicit external-state dependency. The supplied
// Set is in-memory test state, NOT a production durable anti-replay store.
export function verifySyntheticOperatorDecision(d,a,witness,custodianPublicKey,
  alert,trustedOperatorKey,seenNonces,now=Date.now()) {
  const refuse=()=>Object.freeze({accepted:false,action:'manual_review_required',
    automaticReplayAuthorized:false,realHumanAcknowledgement:false});
  if (!verifySyntheticCustodyAttestation(a,witness,custodianPublicKey,now) ||
      !EXACT(d,ackKeys) || !validAlert(alert) ||
      !pureKey(trustedOperatorKey,'public') || !(seenNonces instanceof Set) ||
      d.schema!==CUSTODY_ACK.ackSchema || d.operator!==CUSTODY_ACK.operator ||
      d.keyId!==keyId(trustedOperatorKey) ||
      d.attestationHash!==sha(bodyString(a)) || d.alertKey!==alert.key ||
      d.auditHash!==alert.auditHash || d.auditSequence!==alert.auditSequence ||
      !['escalate_no_replay','review_no_replay'].includes(d.decision) ||
      !NONCE.test(d.nonce) || !validTime(d.issuedAt,now,300000) ||
      seenNonces.has(`${d.keyId}:${d.nonce}`) ||
      !verifySignature(attBody(d),d.signature,trustedOperatorKey)) return refuse();
  seenNonces.add(`${d.keyId}:${d.nonce}`);
  return Object.freeze({accepted:true,action:'synthetic_decision_recorded_only',
    automaticReplayAuthorized:false,realHumanAcknowledgement:false});
}
export function guardCustodyAckRehearsal(env=process.env,argc=process.argv.length) {
  const pg=/^(?:PGPASSWORD|PGPASSFILE|PGHOST|PGHOSTADDR|PGPORT|PGUSER|PGDATABASE|PGSERVICE|PGSERVICEFILE|PGOPTIONS|PGCLUSTER|PGSSLMODE|PGSSLCERT|PGSSLKEY|PGSSLROOTCERT)$/;
  return argc===2 && env.PULSE_D15C5H_DISPOSABLE_ONLY==='YES' &&
    env.NODE_ENV!=='production' && !env.DATABASE_URL &&
    !env.PULSE_D15C5H_DELIVERY_URL && !env.PULSE_D15C5H_EXTERNAL_CUSTODY &&
    !env.PULSE_D15C5H_LIVE_OPERATOR && !env.PULSE_D15C5H_APPROVE &&
    !Object.keys(env).some(k=>pg.test(k));
}

/**
 * Verify the signed decision against a snapshot of the *entire* previously
 * verified 5F outbox, not an untrusted alert object by itself. The caller
 * must first run 5G inspectFrozenRecovery and readPrivateOutbox under its
 * test-only source locks; this function independently verifies the frozen
 * outbox hash and exact alert membership before consuming the nonce.
 */
export function verifyDecisionAgainstFrozenOutbox(d,a,w,custodianPublicKey,
  trustedOutbox,alert,operatorPublicKey,seenNonces,now=Date.now()) {
  const refused=Object.freeze({accepted:false,action:'manual_review_required',
    automaticReplayAuthorized:false,realHumanAcknowledgement:false});
  if (!validWitness(w) || !EXACT(trustedOutbox,['schema','records']) ||
      trustedOutbox.schema!=='pulse-local-alert-handoff/v1' ||
      !Array.isArray(trustedOutbox.records) ||
      trustedOutbox.records.length!==w.outboxCount ||
      trustedOutbox.records.length>32 ||
      sha(JSON.stringify(trustedOutbox))!==w.outboxHash || !validAlert(alert)) return refused;
  const keys=new Set();let match=0;
  for (const row of trustedOutbox.records) {
    if (!validAlert(row) || keys.has(row.key)) return refused;
    keys.add(row.key);
    if (row.key===alert.key && bodyString(row)===bodyString(alert)) match++;
  }
  if (match!==1) return refused;
  return verifySyntheticOperatorDecision(d,a,w,custodianPublicKey,alert,
    operatorPublicKey,seenNonces,now);
}
