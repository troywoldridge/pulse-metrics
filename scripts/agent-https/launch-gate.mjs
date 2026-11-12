/** D12 informational safety gate; cannot authorize live production enrollment. */
import { verifyD12Foundation } from './verify-foundation.mjs';
try {
  verifyD12Foundation();
  console.log('PULSE METRICS — PHASE 2E3C5D12 PRELAUNCH REVIEW');
  console.log('PASS: pinned D11 sources, local-only runner and unmounted public enrollment');
  console.log('PASS: D12 HTTPS transport defaults to verified CA+hostname and no redirects');
  console.log('PENDING: operator-approved HTTPS control plane and agent-id preallocation');
  console.log('PENDING: safe stdin/FD token delivery without shell-history exposure');
  console.log('PENDING: approved migration, real TLS proxy, WorkOS and distributed rate limits');
  console.log('PENDING: real staging agent enrollment, reconciliation and revocation exercises');
  console.log('PENDING: authenticated genuine telemetry ingest, persistence and tenant-safe read API');
  console.log('PUBLIC LAUNCH: NO_GO — no active enrollment endpoints or telemetry transport');
} catch {
  console.error('REFUSE_D12_LAUNCH_AUDIT: protected source mismatch');
  process.exitCode = 1;
}
