/**
 * Pulse Metrics D15C-5J — architecture REVIEW contract, NOT an authenticator.
 * Pure functions only: no database, network, filesystem writes, scheduler or IAM.
 * A correct blueprint always requires independently authenticated review.
 */

export const ARCHITECTURE_REVIEW = Object.freeze({
  schema: 'pulse-maintenance-production-boundaries/v1',
  registerSchema: 'pulse-maintenance-release-gates/v1',
  productionAuthorized: false,
  grantsApplied: false,
  externalCustodyVerified: false,
  realOperatorVerified: false,
  automaticAmbiguousReplayAllowed: false,
  publicLaunch: 'NO_GO',
});

const GATE_IDS = Object.freeze([
  'deployment_platform_selected',
  'production_network_segmentation',
  'dedicated_workload_identity',
  'database_tls_identity_verification',
  'maintenance_function_grant_audit',
  'independent_custody_account_and_retention',
  'external_signing_key_lifecycle',
  'atomic_outbox_and_replay_uniqueness',
  'authenticated_operator_step_up_and_revocation',
  'dual_control_and_manual_recovery',
  'independent_human_acknowledgement',
  'alert_transport_and_dead_letter_drill',
  'encrypted_backup_pitr_and_restore',
  'incident_response_and_kill_switch',
  'tenant_and_negative_security_integration',
  'production_change_approval_and_rollback',
]);
export const REQUIRED_RELEASE_GATES = GATE_IDS;

/** A proposed design, never a discovered or deployed topology. */
export const PROPOSED_BOUNDARIES = Object.freeze({
  schema: ARCHITECTURE_REVIEW.schema,
  reviewOnly: true,
  publicLaunch: 'NO_GO',
  workloads: {
    api: {
      principal: 'api_workload_separate_proposed',
      databaseRole: 'pulse_metrics_app',
      privileges: 'existing_restricted_runtime_only',
    },
    telemetry: {
      principal: 'dedicated_ingest_workload_proposed',
      databaseRole: 'ingest_executor_separately_reviewed_proposed',
      identitySource: 'authenticated_agent_and_verified_proxy_proposed',
    },
    maintenance: {
      principal: 'dedicated_nonhuman_workload_identity_proposed',
      databaseRole: 'pulse_metrics_maintenance_runner_proposed',
      privileges: 'reviewed_bounded_maintenance_execute_only',
      connection: 'private_postgresql_tls_verify_full_proposed',
      enabled: false,
    },
    evidenceCustodian: {
      principal: 'separately_administered_custodian_proposed',
      domain: 'different_security_administration_boundary_proposed',
      storage: 'retention_locked_versioned_external_storage_proposed',
      keys: 'independent_kms_or_hsm_proposed',
      enabled: false,
    },
    alertDispatcher: {
      principal: 'dedicated_delivery_workload_proposed',
      destination: 'trusted_admin_configured_destination_proposed',
      enabled: false,
    },
    humanOperator: {
      identity: 'federated_verified_operator_proposed',
      authorization: 'current_ops_role_and_step_up_proposed',
      approval: 'separate_reviewer_for_sensitive_recovery_proposed',
      verified: false,
    },
  },
  state: {
    store: 'transactional_postgresql_proposed',
    outbox: 'atomic_with_business_event_and_durable_receipts_proposed',
    decisionNonce: 'unique_operator_key_nonce_and_unique_alert_key_proposed',
    dispatcher: 'lease_and_fencing_or_row_locking_proposed',
    ambiguousInFlight: 'manual_reconciliation_no_automatic_retry',
    backup: 'encrypted_pitr_restore_drills_required',
  },
  activation: {
    providerSelected: false,
    databaseGrantsApplied: false,
    scheduleEnabled: false,
    networkDeliveryEnabled: false,
    productionDeploymentApproved: false,
  },
});

/** Reject untrusted accessor objects, unknown fields, functions and odd prototypes. */
function strictData(value, depth = 0) {
  if (depth > 12) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.length <= 64 &&
    Object.keys(value).length === value.length &&
    value.every(item => strictData(item, depth + 1));
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  if (keys.length > 64) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every(key => key !== '__proto__' && key !== 'constructor' &&
    Object.hasOwn(descriptors[key], 'value') &&
    strictData(descriptors[key].value, depth + 1));
}
function exactlyEqual(actual, expected) {
  if (!strictData(actual)) return false;
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (Array.isArray(expected)) return Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((item, i) => exactlyEqual(actual[i], item));
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const expectedKeys = Object.keys(expected);
  return Object.keys(actual).length === expectedKeys.length &&
    expectedKeys.every(key => Object.hasOwn(actual, key) &&
      exactlyEqual(actual[key], expected[key]));
}

/**
 * A valid proposed topology is not evidence that any service exists.
 * Even perfect input will NEVER authorize production operations.
 */
export function reviewProposedBoundaries(candidate) {
  if (!exactlyEqual(candidate, PROPOSED_BOUNDARIES)) {
    return Object.freeze({ decision: 'rejected', reason: 'unsafe_or_unreviewed_topology',
      productionAuthorized: false, publicLaunch: 'NO_GO' });
  }
  return Object.freeze({ decision: 'review_required',
    reason: 'real_provider_identity_grants_custody_and_tests_not_proven',
    productionAuthorized: false, publicLaunch: 'NO_GO' });
}

const GATE_ITEM = Object.freeze({
  status: 'external_verification_required',
  evidenceReference: null,
  externalReviewer: null,
});
const REGISTER_KEYS = Object.freeze(['schema', 'purpose', 'launchStatus', 'gates']);
const GATE_ENTRY_KEYS = Object.freeze(['id', ...Object.keys(GATE_ITEM)]);

/** A source inventory, NOT an attestation or independent release approval. */
export function inspectReleaseGateRegister(register) {
  if (!strictData(register) || !register || Array.isArray(register) ||
      Object.keys(register).sort().join('|') !== [...REGISTER_KEYS].sort().join('|') ||
      register.schema !== ARCHITECTURE_REVIEW.registerSchema ||
      register.purpose !== 'design_only_unverified_evidence_inventory' ||
      register.launchStatus !== 'NO_GO' || !Array.isArray(register.gates) ||
      register.gates.length !== GATE_IDS.length) {
    return Object.freeze({ decision: 'rejected', reason: 'invalid_gate_register',
      productionAuthorized: false, publicLaunch: 'NO_GO' });
  }
  const ids = new Set();
  for (const gate of register.gates) {
    if (!gate || Array.isArray(gate) ||
        Object.keys(gate).sort().join('|') !== [...GATE_ENTRY_KEYS].sort().join('|') ||
        !GATE_IDS.includes(gate.id) || ids.has(gate.id) ||
        !exactlyEqual({ status: gate.status,
          evidenceReference: gate.evidenceReference,
          externalReviewer: gate.externalReviewer }, GATE_ITEM)) {
      return Object.freeze({ decision: 'rejected', reason: 'invalid_gate_register',
        productionAuthorized: false, publicLaunch: 'NO_GO' });
    }
    ids.add(gate.id);
  }
  if (GATE_IDS.some(id => !ids.has(id))) {
    return Object.freeze({ decision: 'rejected', reason: 'invalid_gate_register',
      productionAuthorized: false, publicLaunch: 'NO_GO' });
  }
  return Object.freeze({ decision: 'blocked', gateCount: GATE_IDS.length,
    externallyVerifiedGates: 0, evidenceCollected: 0,
    reason: 'no_independently_verified_release_evidence',
    productionAuthorized: false, publicLaunch: 'NO_GO' });
}

const STATES = Object.freeze(['queued', 'in_flight', 'transport_accepted',
  'receiver_duplicate', 'dead_letter', 'unknown']);
const ACTIONS = Object.freeze(['inspect', 'request_manual_reconciliation',
  'automatic_retry', 'send_again', 'mark_human_acknowledged',
  'approve_production', 'grant_database_role']);
/** A policy preview; never persists or performs an operation. */
export function reviewRecoveryAction(input) {
  if (!strictData(input) || !input || Array.isArray(input) ||
      Object.keys(input).sort().join('|') !== 'action|sourceState' ||
      !STATES.includes(input.sourceState) || !ACTIONS.includes(input.action)) {
    return Object.freeze({ decision: 'rejected', reason: 'invalid_request',
      performed: false, productionAuthorized: false });
  }
  if (!['inspect', 'request_manual_reconciliation'].includes(input.action)) {
    return Object.freeze({ decision: 'denied',
      reason: 'no_live_replay_or_admin_capability',
      performed: false, productionAuthorized: false });
  }
  return Object.freeze({ decision: 'manual_review_required',
    reason: input.sourceState === 'in_flight' || input.sourceState === 'unknown' ?
      'delivery_outcome_ambiguous' : 'independent_evidence_required',
    performed: false, productionAuthorized: false });
}

/** A strict offline guard; never inspects or connects to production resources. */
export function guardArchitectureRehearsal(env, argc) {
  const unsafeNames = [
    'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'DIRECT_URL', 'PGHOST', 'PGHOSTADDR',
    'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE',
    'PGPASSFILE', 'PGSSLCERT', 'PGSSLKEY', 'PGSSLROOTCERT', 'PGSSLCRL', 'PGOPTIONS',
    'ALERT_WEBHOOK_URL', 'ALERT_DESTINATION_URL', 'MAINTENANCE_DATABASE_URL',
    'PULSE_D15C5J_PRODUCTION', 'PULSE_D15C5J_DEPLOY', 'PULSE_D15C5J_SEND_ALERT',
    'PULSE_D15C5J_OPERATOR_TOKEN', 'PULSE_D15C5J_CUSTODY_URL',
  ];
  if (!env || typeof env !== 'object' || Array.isArray(env) ||
      env.PULSE_D15C5J_REVIEW_ONLY !== 'YES' ||
      env.NODE_ENV === 'production' ||
      argc !== 2 ||
      unsafeNames.some(name => Object.hasOwn(env, name))) {
    throw Error('d15c5j_design_guard_denied');
  }
  return Object.freeze({ reviewOnly: true, productionAuthorized: false });
}
