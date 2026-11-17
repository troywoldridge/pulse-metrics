# Pulse Metrics — D15C-5U-2F2H stdin permission correction

**Status:** Complete-file correction for the guarded 2F2H operator; live verification pending.

## Failure and correction

The first approved 2F2H live run started the exact quarantined PostgreSQL 16 cluster, but `psql -f scripts/telemetry-persistent/pilot-live-inventory.sql` failed with **Permission denied**. The `postgres` OS account cannot traverse the private project path under the invoking user's home directory. PostgreSQL schema, grants and the SQL audit were not found faulty; the SQL was not executed.

The replacement operator already opens the pinned SQL source as file descriptor 9 for locking. It now gives that **same open descriptor** to `psql` as standard input (`<&9`), with shell redirection performed before `sudo -u postgres`. It does not change the SQL file's permissions, copy SQL to a public path, enable database TCP or alter privileges. The original startup, fallback shutdown and retained backup verification remain unchanged.

The replacement regression suite checks that the operator uses the pinned, locked descriptor rather than `-f` and adds a real shell subprocess demonstration of reading an owner-only SQL file from an inherited FD. Both files are rewritten in full; no partial patching is necessary.

## Installation and verification

1. Confirm the persistent cluster is stopped and the backup byte-hash is intact before installation.
2. Confirm the current operator/test SHA256 values match the documented originals. Install the two *complete* replacements only after verifying the ZIP and extracted file hashes; refuse symlinks.
3. Run `bash -n` and `node --test scripts/telemetry-persistent/live-pilot-inventory.test.mjs` as the ordinary development user, then `guarded-live-inventory.sh --verify` without approval.
4. Only after successful preflight run `--exercise-empty` with the existing exact `PULSE_APPROVE_5U2F2H_LIVE_EMPTY_INVENTORY=START_READ_ONLY_SNAPSHOT_STOP`. Require both live audit success and final stopped-cluster/backup verification.

## Boundaries

- This is **empty-only** and authorizes no persistent agent enrollment, nonzero telemetry, service activation, network listener, migration or public deployment.
- No original zero-data operator, PostgreSQL data directory, old backup, SQL candidate, inventory policy, or migration file is modified.
- A successful offline test does not establish that the real SQL audit succeeded: the separate live run must report its final PASS markers.
- If the SQL raises a genuine PostgreSQL security or schema error after this correction, stop and investigate it; do not relax its assertions.

**Public launch:** NO_GO. **Persistent telemetry writes:** NOT AUTHORIZED.
