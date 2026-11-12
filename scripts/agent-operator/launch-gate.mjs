/** Read-only prelaunch evidence gate: PASS means NO_GO is preserved. */
import { verifyD14Foundation } from './verify-foundation.mjs';
try {
  verifyD14Foundation();
  console.log('PULSE METRICS — D11–D14 DEVELOPMENT BLOCK CLOSEOUT REVIEW');
  console.log('PASS: D11 vault, D12 TLS, D13 identity and D14 CLI boundaries retained');
  console.log('PASS: D14 does not activate public enrollment or send agent telemetry');
  console.log('PENDING: reviewed production migration rollout, backup and recovery sign-off');
  console.log('PENDING: real edge/origin TLS, trusted proxy and WorkOS/quotas staging evidence');
  console.log('PENDING: approved operator UI, protected token handoff, enrollment and recovery trials');
  console.log('PENDING: packaging/signing Linux agent, systemd isolation and credential lifecycle');
  console.log('PENDING: authenticated telemetry ingest, tenant-safe persistence, retention and UI');
  console.log('PUBLIC LAUNCH: NO_GO — test success is not release authorization');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'D14 launch gate unavailable');
  process.exitCode = 1;
}
