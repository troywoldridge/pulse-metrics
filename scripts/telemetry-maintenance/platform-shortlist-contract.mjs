/**
 * D15C-5K — pure, OFFLINE, nonauthorizing platform-review contract.
 * Vendor prices are fixed 2026-11-14 snapshots; home-host costs UNKNOWN. No provider communication or
 * provision capability. A passing shortlist is NEVER deployment approval.
 */

export const PLATFORM_REVIEW_INVARIANTS = Object.freeze({
  schema: 'pulse-d15c5k-platform-shortlist/v1',
  launch: 'NO_GO',
  productionAuthorized: false,
  resourcesProvisioned: false,
  deploymentAllowed: false,
  accountCreationAllowed: false,
  candidateAcceptanceAllowed: false,
  externalEvidenceVerified: false,
  automaticAlertReplayAllowed: false,
});

const EXPECTED_OPTIONS = [
  {
    id: 'do_basic_managed_pg', provider: 'DigitalOcean',
    applicationSku: 'Basic Droplet 2 vCPU 4 GiB RAM', appMonthlyUsd: 24,
    databaseSku: 'Managed PostgreSQL 1 GiB single-node', databaseMonthlyUsd: 15,
    baseMonthlyUsd: 39, tlsMode: 'verify-full-required',
    privateNetwork: 'same-vpc-required', databaseAvailability: 'single-node-not-high-availability',
    custody: 'separate-aws-security-account-object-lock-proposed',
    identity: 'separate-api-ingest-maintenance-and-custodian-principals-unproven',
    status: 'unverified_candidate_not_for_customers',
  },
  {
    id: 'render_2g_managed_pg', provider: 'Render',
    applicationSku: 'Web Service 1 CPU 2 GiB RAM', appMonthlyUsd: 25,
    databaseSku: 'Managed PostgreSQL 1 GiB RAM', databaseMonthlyUsd: 19,
    baseMonthlyUsd: 44, tlsMode: 'internal-tls-require-only-verify-full-not-supported',
    privateNetwork: 'same-account-same-region-internal-url',
    databaseAvailability: 'verify-plan-and-recovery-window',
    custody: 'separate-aws-security-account-object-lock-proposed',
    identity: 'separate-api-ingest-maintenance-and-custodian-principals-unproven',
    status: 'blocked-by-5j-tls-requirement-unless-reviewed-redesign',
  },
  {
    id: 'do_ha_database_scenario', provider: 'DigitalOcean',
    applicationSku: 'Basic Droplet 2 vCPU 4 GiB RAM', appMonthlyUsd: 24,
    databaseSku: 'Managed PostgreSQL HA primary and standby at published entry price',
    databaseMonthlyUsd: 60, baseMonthlyUsd: 84,
    tlsMode: 'verify-full-required', privateNetwork: 'same-vpc-required',
    databaseAvailability: 'ha-capability-still-requires-failure-drill',
    custody: 'separate-aws-security-account-object-lock-proposed',
    identity: 'separate-api-ingest-maintenance-and-custodian-principals-unproven',
    status: 'unverified-budget-scenario_not_for_customers',
  },
  {
    id: 'self_host_existing_server_pilot', provider: 'Existing owner-operated server',
    applicationSku: 'Ubuntu 24.04.3 LTS, Intel N5095 4-core, 19 GiB RAM (observed)',
    appMonthlyUsd: null,
    databaseSku: 'Existing PostgreSQL 16; dedicated restricted Pulse Metrics database proposed',
    databaseMonthlyUsd: null,
    baseMonthlyUsd: null,
    tlsMode: 'local-unix-socket-preferred-remote-tls-verify-full-if-used',
    privateNetwork: 'loopback-or-private-admin-ssh-tunnel-no-public-db-port',
    databaseAvailability: 'single-site-single-host-no-ha',
    custody: 'external-independently-administered-custody-required-not-provisioned',
    identity: 'dedicated-app-migrator-maintenance-custodian-principals-unverified',
    status: 'conditional-private-noncustomer-pilot-only',
  },
];

const UNPRICED_ITEMS = [
  'droplet-backups', 'independent-audit-storage-and-requests',
  'independent-signing-keys', 'network-egress-and-cross-provider-transfer',
  'monitoring-and-notifications', 'domain-tax-and-support',
  'second-availability-zone-and-recovery-operations',
  'home-server-electricity-ups-isp-and-replacement-parts',
  'encrypted-offsite-backup-restore-costs',
  'fiber-outage-and-single-site-recovery-plan',
];
const REQUIRED_EVIDENCE = [
  'managed-pg-roles-grants-and-force-rls', 'database-hostname-and-ca-validation',
  'restricted-networking-and-actual-firewall', 'backup-pitr-and-restore-drill',
  'independent-custody-identity-and-object-version-lock',
  'signing-algorithm-key-rotation-and-trusted-public-keys',
  'separate-principals-and-secret-revocation',
  'concurrent-outbox-and-nonce-transaction-tests',
  'capacity-load-and-error-budget', 'operator-step-up-and-two-person-recovery',
  'legal-retention-data-deletion-and-privacy',
  'owner-approved-budget-and-change-control',
  'single-site-server-cpu-disk-and-network-load-measurement',
  'dedicated-service-user-and-no-cross-app-access',
  'postgresql-lan-firewall-and-remote-authentication-review',
  'offsite-backup-and-independent-custody-failure-drill',
];
const SOURCES = [
  'https://www.digitalocean.com/pricing/droplets',
  'https://docs.digitalocean.com/products/databases/postgresql/details/pricing/',
  'https://docs.digitalocean.com/products/databases/postgresql/how-to/connect/',
  'https://docs.digitalocean.com/products/databases/postgresql/how-to/modify-user-privileges/',
  'https://render.com/pricing',
  'https://render.com/docs/postgresql-creating-connecting',
  'https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html',
];

function freezeTree(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

export const FIXED_SHORTLIST = freezeTree({
  schema: 'pulse-d15c5k-platform-shortlist/v1',
  purpose: 'offline_candidate_comparison_not_authorization',
  asOf: '2026-11-14',
  decisionStatus: 'proposed_not_accepted',
  publicLaunch: 'NO_GO', productionAuthorized: false,
  resourcesProvisioned: false, proposedPilot: 'self_host_existing_server_pilot',
  // Observations supplied by the owner, not independently benchmarked or certified.
  serverInspection: {
    evidenceClass: 'operator_read_only_terminal_observation',
    observedDate: '2026-11-14',
    os: 'Ubuntu 24.04.3 LTS',
    cpu: 'Intel Celeron N5095',
    logicalCores: 4,
    ramGiB: 19,
    availableRamGiBObserved: 18,
    primaryDiskTiBApprox: '1.8',
    secondaryDiskTiBApprox: '1.8',
    twoDisksAreIndependentOffsiteBackup: false,
    existingSiteAndWorkerPreserved: true,
    obsoleteApplicationStopped: true,
    postgresqlVersion: 16,
    postgresqlListenerOnAllInterfaces: true,
    ufw5432WideOpenRemoved: true,
    ufw5432LegacySourceRuleStillPresent: true,
    developerTcpTunnelEndpointReachable: true,
    postgresAuthenticationThroughTunnelVerified: false,
    publicIpReachabilityAudited: false,
    offsiteRestoreDrillPassed: false,
    independentCustodyVerified: false,
    loadTestPassed: false,
    publicLaunchApproved: false,
  },
  options: EXPECTED_OPTIONS,
  unpricedItems: UNPRICED_ITEMS,
  requiredExternalEvidence: REQUIRED_EVIDENCE,
  releaseGateCount: 16,
  externallyVerifiedReleaseGates: 0,
  sources: SOURCES,
});

/** Strictly reject getters, polluted prototypes, functions, non-integers and unknown keys. */
function plainData(value, depth = 0) {
  if (depth > 12) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 64) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes('length')) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') ||
          !plainData(descriptor.value, depth + 1)) return false;
    }
    return true;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  return keys.length <= 64 && keys.every(key => typeof key === 'string' &&
    key !== '__proto__' && key !== 'constructor' &&
    Object.hasOwn(descriptors[key], 'value') && plainData(descriptors[key].value, depth + 1));
}

function equalExact(a, b) {
  if (b === null || typeof b !== 'object') return a === b;
  if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length &&
    b.every((item, i) => equalExact(a[i], item));
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const keys = Object.keys(b);
  return Object.keys(a).length === keys.length &&
    keys.every(key => Object.hasOwn(a, key) && equalExact(a[key], b[key]));
}

const DENIAL = Object.freeze({
  decision: 'rejected', reason: 'unreviewed_or_tampered_platform_shortlist',
  productionAuthorized: false, publicLaunch: 'NO_GO',
});

export function inspectPlatformShortlist(proposal) {
  if (!plainData(proposal) || !equalExact(proposal, FIXED_SHORTLIST)) return DENIAL;
  // There is intentionally no branch capable of accepting a real provider.
  return Object.freeze({
    decision: 'external_review_required',
    candidate: 'self_host_existing_server_pilot',
    candidateAccepted: false, productionAuthorized: false,
    publicLaunch: 'NO_GO', releaseGatesVerified: 0,
    reason: 'single_site_security_isolation_backup_identity_load_and_custody_unverified',
  });
}

export function inspectCostScenario(proposal, id) {
  if (inspectPlatformShortlist(proposal).decision !== 'external_review_required' ||
      typeof id !== 'string') {
    return Object.freeze({ decision: 'rejected', productionAuthorized: false });
  }
  const row = EXPECTED_OPTIONS.find(option => option.id === id);
  if (!row) return Object.freeze({ decision: 'rejected', productionAuthorized: false });
  // Never invent a zero-dollar hosting quote for existing owned equipment.
  if (id === 'self_host_existing_server_pilot') {
    if (row.appMonthlyUsd !== null || row.databaseMonthlyUsd !== null ||
        row.baseMonthlyUsd !== null) {
      return Object.freeze({ decision: 'rejected', productionAuthorized: false });
    }
    return Object.freeze({
      decision: 'unquantified_existing_hardware', id, subtotalUsd: null,
      allInQuote: false, productionAuthorized: false, publicLaunch: 'NO_GO',
      excludedCostCategories: UNPRICED_ITEMS.length,
    });
  }
  const subtotal = row.appMonthlyUsd + row.databaseMonthlyUsd;
  if (subtotal !== row.baseMonthlyUsd) {
    return Object.freeze({ decision: 'rejected', productionAuthorized: false });
  }
  return Object.freeze({
    decision: 'illustrative_only', id, subtotalUsd: subtotal,
    allInQuote: false, productionAuthorized: false, publicLaunch: 'NO_GO',
    excludedCostCategories: UNPRICED_ITEMS.length,
  });
}

export function guardPlatformReview(env, argc) {
  const forbidden = [
    'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'DIRECT_URL', 'PGHOST',
    'PGHOSTADDR', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE',
    'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGSSLCERT', 'PGSSLKEY',
    'PGSSLROOTCERT', 'PGSSLCRL', 'PGOPTIONS', 'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE',
    'DIGITALOCEAN_ACCESS_TOKEN', 'DO_TOKEN', 'RENDER_API_KEY',
    'S3_BUCKET', 'KMS_KEY_ID', 'ALERT_WEBHOOK_URL', 'ALERT_DESTINATION_URL',
    'MAINTENANCE_DATABASE_URL', 'PULSE_D15C5K_DEPLOY',
    'PULSE_D15C5K_APPROVED', 'PULSE_D15C5K_PRODUCTION',
    'PULSE_D15C5K_PURCHASE', 'PULSE_D15C5K_SELFHOST_DEPLOY',
  ];
  if (!env || typeof env !== 'object' || Array.isArray(env) ||
      env.PULSE_D15C5K_REVIEW_ONLY !== 'YES' ||
      env.NODE_ENV === 'production' || argc !== 2 ||
      forbidden.some(name => Object.hasOwn(env, name))) {
    throw Error('d15c5k_offline_guard_denied');
  }
  return Object.freeze({ reviewOnly: true, productionAuthorized: false,
    networkAllowed: false, providerSelected: false, publicLaunch: 'NO_GO' });
}
