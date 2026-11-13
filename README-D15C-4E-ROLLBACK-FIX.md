# Pulse Metrics D15C-4E — Rehearsal rollback audit fix

**Review-only.** This package replaces the complete `scripts/test-telemetry-agent-quota-http-rehearsal.sh` file and changes no migrations, runtime endpoints, or application files.

## Why

The previous rehearsal accidentally included a shell `refuse` line in a SQL heredoc. PostgreSQL reported `syntax error at or near "refuse"`, while the script still printed a misleading rollback PASS. Therefore that specific rollback assertion was **not verified**.

## Fix

- SQL starts immediately after the heredoc declaration.
- Run rollback verification inside `BEGIN READ ONLY`.
- Require the SQL command to exit successfully (no masked SQL error).
- Require the exact one-line result `rollback_secure`.
- Verify agent-quota migration ledger has one row and no `0002` receipt and the D15C-4B function source fingerprint is unchanged.
- Keep the existing disposable Unix-socket-only guard, full migration replay, checks, and cluster cleanup.

## Local steps

```bash
cd ~/Projects/pulse-metrics
unzip -o ~/Downloads/pulse-metrics-d15c4e-rollback-audit-fix.zip
bash -n scripts/test-telemetry-agent-quota-http-rehearsal.sh
node scripts/telemetry-auth-outcome/verify-candidate.mjs
bash scripts/test-telemetry-agent-quota-http-rehearsal.sh
```

**Do not commit until the script has been rerun and the rollback audit passes without unexpected SQL errors. Do not apply any SQL to the ordinary database.**
