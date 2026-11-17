# D15C-5U-2F2K: EMBEDDED INTO a verified generated copy of the D15C-4B
# rehearsal after quota and agent quota migrations, BEFORE two-tenant fixtures.
# Depends on original guarded shell functions, variables, cleanup and traps.
# This stage is not executable standalone and has no function entry point.
echo '========== D15C-5U-2F2K REVIEWED DISPOSABLE SECURITY REVISION =========='
refuse_2f2k() { printf 'REFUSE_D15C5U2F2K: %s\n' "$*" >&2; exit 1; }
[[ "$PORT" == 55432 && "$DATA" == "$BASE/data" && "$SOCKET" == "$BASE/socket" &&
   "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] ||
  refuse_2f2k 'unexpected disposable target'
sudo -u postgres test -f "$BASE/.pulse-telemetry-quota-marker" ||
  refuse_2f2k 'missing original disposable-only marker'

AUTH_SQL='scripts/telemetry-auth-outcome/migrations/0002_machine_credential_rejection.sql'
AUTH_EXPECTED='3061f797a7d1fa0dfb335130252c4d89a3d1ee50d263854a22caa2a6c4d8c771'
[[ -f "$AUTH_SQL" && ! -L "$AUTH_SQL" ]] || refuse_2f2k '4E candidate missing'
[[ "$(sha256sum "$AUTH_SQL" | cut -d' ' -f1)" == "$AUTH_EXPECTED" ]] ||
  refuse_2f2k '4E candidate drift'
node scripts/telemetry-auth-outcome/verify-candidate.mjs
psql_admin pulse_metrics -q < "$AUTH_SQL"
psql_admin pulse_metrics -q < scripts/telemetry-ingestion/release-permission-gate.sql
psql_admin pulse_metrics -q <<'SQL4E2F2K'
DO $verify$
DECLARE v_hash text;
BEGIN
  SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') INTO v_hash
  FROM pg_proc p
  WHERE p.oid='pulse_telemetry_ingestion.ingest_submission(text,uuid,text,timestamptz,integer,real,real,real,bigint,bigint,jsonb)'::regprocedure;
  IF v_hash IS DISTINCT FROM '04abf246ad3c10b3352c2cc52165a70c5f736d2280452bb4e0c02d84e04774e2'
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations) <> 2
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_agent_quota.schema_migrations
                    WHERE version='0002')
  THEN RAISE EXCEPTION 'REFUSE_D15C5U2F2K: 4E patch/receipt mismatch'; END IF;
END;
$verify$;
SQL4E2F2K

# A SQL FD held by the original local repository owner crosses into the
# sudo postgres client without requiring directory permission changes.
FIXTURE='scripts/telemetry-persistent/disposable-one-tenant-identity-fixture.sql'
[[ -f "$FIXTURE" && ! -L "$FIXTURE" && "$(stat -c %h "$FIXTURE")" == 1 ]] ||
  refuse_2f2k 'fixture SQL not a regular unlinked file'
exec 8< "$FIXTURE"
[[ "$(sha256sum /proc/self/fd/8 | cut -d' ' -f1)" == 'fed4cb4efee851a85f705dccdff58848a9ed76512201de3e9bc485b150f63a51' ]] ||
  refuse_2f2k 'fixture SQL checksum mismatch'
psql_admin pulse_metrics -q <&8
exec 8<&-

echo '========== D15C-5U-2F2K REAL ONE-TENANT READ-ONLY IDENTITY AUDIT =========='
AUDITOR='scripts/telemetry-persistent/read-disposable-pilot-identity.sh'
[[ -f "$AUDITOR" && ! -L "$AUDITOR" ]] || refuse_2f2k '2F2J auditor unavailable'
[[ "$(sha256sum "$AUDITOR" | cut -d' ' -f1)" == 'e16e24406db1a5a77836a060fbc837d86cac5c355443026feee6e9ec713ba0d9' ]] ||
  refuse_2f2k '2F2J auditor changed'
# A valid SQL execution and exact nonsecret shape are both required.
env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  timeout --signal=TERM --kill-after=5s 30s \
  bash "$AUDITOR" --audit-existing-disposable "$SOCKET"
echo 'PASS: genuine PostgreSQL 16 one-tenant owner/agent identity verified, read-only'

expect_denied_2f2k() {
  local label="$1" denied_output
  if denied_output="$(
      env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS -u DATABASE_URL \
          -u MIGRATION_DATABASE_URL timeout --signal=TERM --kill-after=5s 30s \
      bash "$AUDITOR" --audit-existing-disposable "$SOCKET" 2>&1
    )"; then
    refuse_2f2k "negative test unexpectedly passed: $label"
  fi
  [[ "$denied_output" == *'REFUSE_D15C5U2F2J'* ]] ||
    refuse_2f2k "negative test failed for unexpected reason: $label"
  echo "PASS: expected live read-only identity rejection: $label"
}

# These are deliberate DISPOSABLE fixture mutations only. Every mutation is
# limited to the exact one-row synthetic roster; a failure invokes the original
# baseline's mandatory isolated cluster cleanup and never reaches 55433.
echo '========== D15C-5U-2F2K NEGATIVE LIVE DATABASE PROBES =========='
psql_admin pulse_metrics -q <<'SQLVIEWER'
DO $check$ BEGIN
  IF (SELECT count(*) FROM public.organization_memberships WHERE role='owner') <> 1
  THEN RAISE EXCEPTION 'REFUSE_D15C5U2F2K: pre-viewer role mismatch'; END IF;
END; $check$;
UPDATE public.organization_memberships SET role='viewer' WHERE role='owner';
SQLVIEWER
expect_denied_2f2k 'owner downgraded to viewer'
psql_admin pulse_metrics -q <<'SQLOWNER'
UPDATE public.organization_memberships SET role='owner' WHERE role='viewer';
SQLOWNER

psql_admin pulse_metrics -q <<'SQLREVOKEAGENT'
DO $check$ BEGIN
  IF (SELECT count(*) FROM public.monitored_agents WHERE status='active') <> 1
  THEN RAISE EXCEPTION 'REFUSE_D15C5U2F2K: pre-revocation agent status mismatch'; END IF;
END; $check$;
UPDATE public.monitored_agents SET status='revoked' WHERE status='active';
SQLREVOKEAGENT
expect_denied_2f2k 'agent revoked'
psql_admin pulse_metrics -q <<'SQLRESTOREAGENT'
UPDATE public.monitored_agents SET status='active' WHERE status='revoked';
SQLRESTOREAGENT

psql_admin pulse_metrics -q <<'SQLREVOKECRED'
DO $check$ BEGIN
  IF (SELECT count(*) FROM public.agent_credentials WHERE revoked_at IS NULL) <> 1
  THEN RAISE EXCEPTION 'REFUSE_D15C5U2F2K: pre-revocation credential mismatch'; END IF;
END; $check$;
UPDATE public.agent_credentials SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL;
SQLREVOKECRED
expect_denied_2f2k 'credential revoked'
psql_admin pulse_metrics -q <<'SQLRESTORECRED'
UPDATE public.agent_credentials SET revoked_at=NULL WHERE revoked_at IS NOT NULL;
SQLRESTORECRED

psql_admin pulse_metrics -q <<'SQLADDUSER'
DO $synthetic$ BEGIN
  PERFORM public.resolve_workos_user('user_d15c5u2f2k_unexpected_extra');
END; $synthetic$;
SQLADDUSER
expect_denied_2f2k 'unexpected second user'
psql_admin pulse_metrics -q <<'SQLDELETEEXTRA'
DELETE FROM public.users WHERE auth_subject='user_d15c5u2f2k_unexpected_extra';
SQLDELETEEXTRA

echo '========== D15C-5U-2F2K RESTORED POSITIVE IDENTITY AUDIT =========='
env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  timeout --signal=TERM --kill-after=5s 30s \
  bash "$AUDITOR" --audit-existing-disposable "$SOCKET"
psql_admin pulse_metrics -q < scripts/telemetry-ingestion/release-permission-gate.sql
echo '========== D15C-5U-2F2K ONE-TENANT LIVE SQL REHEARSAL: PASS =========='
echo 'SYNTHETIC DATABASE ONLY | NO SIGNING AUTHORITY | NO PERSISTENT WRITES | PUBLIC LAUNCH: NO_GO'
# The generated full rehearsal immediately exits 0. Original baseline trap
# stops and removes /tmp/pulse-replay-XXXXXXXXXX and its owned marker.
