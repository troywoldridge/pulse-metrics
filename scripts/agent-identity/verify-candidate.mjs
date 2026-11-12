/** D13 read-only reviewed SQL AND exact historical source guard. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_ROOT=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const LOCK_PATH='scripts/agent-identity/identity-source-lock.json';
const SQL_PATH='scripts/agent-identity/migrations/0003_preallocated_identity.sql';
const GIT_BASE='d2f91c305703fe6d4ac713672c83f82bd41d9f6b';
// Independently reviewed digest: not taken from the user-editable lock file.
const REVIEWED_SQL_SHA256='c085dd674581abe6a636de8cd586e43de745d35ee965c0e141f8dc4015d3b406';
const EXPECTED_PROTECTED=18;
function refuse(reason){throw Error(`REFUSE_D13_SOURCE: ${reason}`);}
function sha256(data){return createHash('sha256').update(data).digest('hex');}
function gitBlob(data){return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');}
function read(root,path){return readFileSync(join(root,path));}
export function verifyD13Source(root=process.cwd(), overrides={}){
  const lock=JSON.parse(read(root,LOCK_PATH).toString('utf8'));
  if(lock.formatVersion!==1||lock.phase!=='2E3C5D13'||
     lock.parentCommit!==GIT_BASE||lock.release!=='REVIEW_ONLY'||
     lock.version!=='0003'||lock.sqlPath!==SQL_PATH||
     lock.sqlSha256!==REVIEWED_SQL_SHA256||
     lock.publicEnrollment!=='UNMOUNTED'||lock.agentTelemetryTransport!=='LOCAL_ONLY'){
    refuse('unrecognized migration lock and release state');
  }
  const bytes=overrides.sqlBytes??read(root,SQL_PATH);
  if(!Buffer.isBuffer(bytes)||sha256(bytes)!==REVIEWED_SQL_SHA256)
    refuse('migration 0003 hash changed');
  const sql=bytes.toString('utf8');
  // Defense in depth. SHA256 already pins all SQL bytes exactly.
  for (const fragment of ['BEGIN;','COMMIT;',
    'CREATE ROLE pulse_metrics_agent_identity_executor',
    'NOLOGIN NOINHERIT NOSUPERUSER',
    'preallocated_agent_bindings ENABLE ROW LEVEL SECURITY',
    'preallocated_agent_bindings FORCE ROW LEVEL SECURITY',
    'issue_preallocated_enrollment', 'redeem_preallocated_enrollment',
    'FOR UPDATE OF t,a','v.status<>\'pending\'',
    'UPDATE public.monitored_agents AS target SET status=\'active\'',
    'AND target.organization_id=v.org AND target.status=\'pending\'',
    'REVOKE EXECUTE ON FUNCTION pulse_agent_enrollment.issue_enrollment',
    'REVOKE EXECUTE ON FUNCTION pulse_agent_enrollment.redeem_enrollment',
    "VALUES ('0003'",'SET search_path=pg_catalog,pg_temp']){
    if(!sql.includes(fragment))refuse('missing reviewed migration invariant');
  }
  const entries=Object.entries(lock.protectedGitBlobs??{});
  if(entries.length!==EXPECTED_PROTECTED)refuse('missing protected Git source pins');
  for(const [path,digest] of entries){
    if(typeof path!=='string'||!/^[A-Za-z0-9_./-]+$/.test(path)||path.startsWith('/')||
       path.split('/').some(s=>s===''||s==='.'||s==='..')||
       typeof digest!=='string'||!/^[a-f0-9]{40}$/.test(digest))
      refuse('unsafe reviewed source lock');
    const bytes=overrides.blobOverrides?.[path]??read(root,path);
    if(gitBlob(bytes)!==digest)refuse('protected historical Git source changed: '+path);
  }
  const packageJson=JSON.parse(read(root,'package.json').toString('utf8'));
  if(packageJson?.scripts?.test!=='node scripts/run-all-tests.mjs')
    refuse('recursive test runner changed');
  const server=read(root,'server.ts').toString('utf8');
  const runner=read(root,'src/agent/run-linux-agent.ts').toString('utf8');
  if(/create(Issue|Redeem)AgentEnrollmentRoute|createIssuePreallocatedEnrollmentRoute|agentEnrollmentIngressVerified/.test(server))
    refuse('public enrollment was unexpectedly enabled');
  if(/redeemAndInstallVerifiedMachineIdentity|createPreauthorizedEnrollmentService|installMachineCredential/.test(runner))
    refuse('local-only agent was unexpectedly wired to network');
  return {pinned:entries.length,sqlSha256:REVIEWED_SQL_SHA256};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==2)refuse('unexpected arguments');
    const checked=verifyD13Source();
    console.log(`PASS: D13 migration 0003 reviewed SHA256 ${checked.sqlSha256}`);
    console.log(`PASS: ${checked.pinned} historical Git blobs unchanged; D9, D10, D11 and D12 preserved`);
    console.log('PASS: enrollment HTTP unmounted, local Linux collector unchanged');
    console.log('PUBLIC LAUNCH: NO_GO — D13 migration is candidate-only');
  }catch(e){console.error(e instanceof Error?e.message:'D13 source verification refused');process.exitCode=1;}
}
