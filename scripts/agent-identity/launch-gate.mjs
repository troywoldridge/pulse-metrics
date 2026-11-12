/** Read-only, evidence-oriented D13 launch gate. Never authorizes deployment. */
import { verifyD13Source } from './verify-candidate.mjs';
try{
  verifyD13Source();
  console.log('PULSE METRICS — D13 PREAUTHORIZED AGENT IDENTITY RELEASE GATE');
  console.log('PASS: D13 pinned migration candidate and immutable historical source');
  console.log('PENDING: independently approved versioned migration execution + rollback/reconciliation');
  console.log('PENDING: WorkOS authenticated issuance and trusted actor+network quotas on real TLS ingress');
  console.log('PENDING: secure one-time token delivery via protected stdin/file descriptor and operator UI');
  console.log('PENDING: real staging preauthorization and token redemption with trusted expected agent ID');
  console.log('PENDING: lost-response recovery, expiration cleanup, credential rotation and agent removal');
  console.log('PENDING: authenticated real telemetry transport, ingestion, tenant-safe read API, retention');
  console.log('PUBLIC LAUNCH: NO_GO — this audit never authorizes public activation');
}catch(e){console.error('REFUSE_D13_LAUNCH_GATE: source audit failed');process.exitCode=1;}
