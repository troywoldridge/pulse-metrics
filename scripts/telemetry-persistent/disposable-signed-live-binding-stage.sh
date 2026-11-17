# D15C-5U-2F2L — EMBEDDED ONLY after the entire 2F2K disposable stage.
# Operates within the SAME verified 55432 throwaway PostgreSQL cluster.
# Pure read-only SQL streamed to a synthetic in-memory signing demonstration.
echo '========== D15C-5U-2F2L LIVE DISPOSABLE SIGNED-IDENTITY BINDING =========='
refuse_2f2l() { printf 'REFUSE_D15C5U2F2L: %s\n' "$*" >&2; exit 1; }
[[ "$PORT" == 55432 && "$DATA" == "$BASE/data" && "$SOCKET" == "$BASE/socket" &&
   "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] ||
  refuse_2f2l 'disposable target identity invalid'
sudo -u postgres test -f "$BASE/.pulse-telemetry-quota-marker" ||
  refuse_2f2l 'reviewed disposable marker absent'
SQL_2F2L='scripts/telemetry-persistent/pilot-identity-evidence.sql'
BINDER_2F2L='scripts/telemetry-persistent/disposable-signed-live-binding.mjs'
[[ -f "$SQL_2F2L" && ! -L "$SQL_2F2L" &&
   -f "$BINDER_2F2L" && ! -L "$BINDER_2F2L" ]] ||
  refuse_2f2l 'required complete source files absent or linked'
[[ "$(stat -c %h "$SQL_2F2L")" == 1 &&
   "$(stat -c %h "$BINDER_2F2L")" == 1 ]] ||
  refuse_2f2l 'linked source not allowed'
[[ "$(sha256sum "$BINDER_2F2L" | cut -d ' ' -f1)" == \
   'a65e6af6b7e03d8f62c802109857e62f4590d0ebdac224009e3671218b389bdc' ]] ||
  refuse_2f2l 'binding implementation drift'
# Open the path as its owner and pin the opened inode. OS user postgres is
# NEVER granted traversal permission to the private project directory.
exec 9< "$SQL_2F2L"
[[ "$(sha256sum /proc/self/fd/9 | cut -d ' ' -f1)" == \
   '7e4550ea927fc52994b8d9137d3b6f348389a8f3fbb78c055be4aac78151710b' ]] ||
  refuse_2f2l 'opened SQL descriptor drift'
# This is SQL BEGIN ... REPEATABLE READ READ ONLY. The exact SQL itself
# rejects any non-disposable server identity, unexpected tenant or RLS drift.
# Original generated runner uses set -euo pipefail, so an error in EITHER
# side of this pipeline denies the rehearsal, followed by cleanup.
sudo -u postgres env -u PGHOST -u PGHOSTADDR -u PGPORT -u PGUSER \
    -u PGDATABASE -u PGOPTIONS -u PGSERVICE -u PGSERVICEFILE \
    -u PGCLUSTER -u PGPASSWORD -u PGPASSFILE \
    "$PG_BIN/psql" -X --no-password -A -t -q -v ON_ERROR_STOP=1 \
    -h "$SOCKET" -p 55432 -U postgres -d pulse_metrics -f - <&9 |
  env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS -u DATABASE_URL \
    -u MIGRATION_DATABASE_URL \
    node "$BINDER_2F2L" --synthetic-disposable-stdin
exec 9<&-
echo '========== D15C-5U-2F2L LIVE SQL + TEST-ONLY SIGNATURE BINDING: PASS =========='
echo 'TEST-ONLY SELF-PINNED KEY | NO INDEPENDENT SIGNER | NO AUTHORIZATION | PUBLIC LAUNCH: NO_GO'
# After this stage: generated complete runner exits normally, invoking the
# pinned original D15C-4B mandatory stop-and-delete trap.
