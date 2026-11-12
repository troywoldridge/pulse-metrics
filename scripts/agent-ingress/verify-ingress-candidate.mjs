#!/usr/bin/env node
/** D10 independent immutable source gate, READ-ONLY. Never contacts PG. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
export const CHECKPOINT='0a128bbd49d302fbb6e4918412d5ba02c895d9d8';
export const D9_DIGEST='273e571549fc5e12dcd5ce882cd64e801a5008f8492147d49a8afb03743922c8';
export const D10_DIGEST='c4213f6dcf95353aad754f9d09f2e08785c42583b74e9b2a8122d96cc0a868d1';
export const SQL_PATH='scripts/agent-ingress/migrations/0002_agent_ingress_quota.sql';
const PROTECTED = Object.freeze({
  'server.ts':'b60547bda0c88d5f3976cba905ede367b38e9581',
  'src/main.tsx':'ef12bb11e4796b05c4e57a07af0c1cfeddffedba',
  'src/db/schema.ts':'cbdfb4e73f93fecc5c7460c63775e179e0bf66cd',
  'src/db/client.ts':'8b88de91999384c6f2873a8daccd605127b4ecc2',
  'src/server/auth/workos-auth.ts':'21e3b48a4c26f88f0ca261657cae9294bce1e287',
  'src/server/security/trusted-client-address.ts':'98f2849dac9d2eb597d0e91280008198f72cb098',
  'src/server/agent-enrollment-routes.ts':'6459ebfaeccc37a915a2dedd57e721a0f3f467aa',
  'src/server/agent-enrollment-service.ts':'bf40133b0ba81149e35defab2586cb401de35d86',
  'scripts/agent-enrollment/verify-candidate.mjs':'6278eefb7ce329c3f9433ddba3da71bd70d6c19b',
  'scripts/agent-enrollment/migrations/0001_agent_enrollment.sql':'8ff39fc2dd7a46b56e402568288081f174099a74',
  'scripts/migrations/privileged-manifest.json':'41f8c2db16b04f742d36afa1e77c4e823e2cf2a6',
});
const SNIPPETS = Object.freeze([
  'BEGIN;', 'CREATE TABLE pulse_agent_enrollment.ingress_rate_limits',
  'FORCE ROW LEVEL SECURITY', 'NOLOGIN NOINHERIT NOSUPERUSER',
  'SECURITY DEFINER', 'SET search_path=pg_catalog,pg_temp',
  'ON CONFLICT (action,bucket_kind,bucket_digest) DO UPDATE',
  'p_action=\'redeem\' AND p_kind=\'network\'',
  'FROM PUBLIC', 'TO pulse_metrics_app',
  "VALUES ('0002','Versioned agent ingress distributed quota boundary');", 'COMMIT;',
]);
function insist(v,why){if(!v)throw Error('REFUSE_D10_SOURCE: '+why);}
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
function git(root,args){return execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
export function scanSql(text){
  const misses=SNIPPETS.filter(s=>!text.includes(s));
  const unsafe=/\bGRANT\s+ALL\b|\bGRANT\s+SELECT\b[^;]*\bTO\s+pulse_metrics_app\b|\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b/i.test(text);
  return {ok:misses.length===0&&!unsafe,misses,unsafe};
}
export function verifyIngressCandidate(root){
  const lock=JSON.parse(readFileSync(resolve(root,'scripts/agent-ingress/migration-lock.json'),'utf8'));
  insist(lock.formatVersion===1 && lock.phase==='2E3C5D10' && lock.checkpoint===CHECKPOINT &&
    lock.kind==='review-only-agent-ingress-quota' && lock.d9Sha256===D9_DIGEST &&
    lock.d10Path===SQL_PATH && lock.d10Sha256===D10_DIGEST,'manifest identity changed');
  const dir=resolve(root,'scripts/agent-ingress/migrations');
  const names=readdirSync(dir).filter(x=>/^\d{4}_.*\.sql$/.test(x));
  insist(names.length===1 && names[0]==='0002_agent_ingress_quota.sql', 'unexpected D10 SQL source');
  insist(hash(readFileSync(resolve(root,'scripts/agent-enrollment/migrations/0001_agent_enrollment.sql')))===D9_DIGEST,
    'D9 migration source modified');
  const sql=readFileSync(resolve(root,SQL_PATH));
  insist(hash(sql)===D10_DIGEST,'D10 SQL checksum mismatch');
  insist(scanSql(sql.toString('utf8')).ok,'D10 security invariants missing');
  for(const [path,blob] of Object.entries(PROTECTED)){
    insist(git(root,['hash-object','--',path])===blob,`protected Git source changed: ${path}`);
  }
  git(root,['merge-base','--is-ancestor',CHECKPOINT,'HEAD']);
  insist(git(root,['branch','--show-current'])==='feat/identity-organization-onboarding','unexpected branch');
  const server=readFileSync(resolve(root,'server.ts'),'utf8');
  insist(!/agent-enrollment-ingress|agent-enrollment-quota|createIssueAgentEnrollmentRoute|createRedeemAgentEnrollmentRoute/.test(server),
    'public HTTP enrollment route must remain disabled');
  return {sha256:D10_DIGEST,version:'0002',launch:'NO_GO'};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {
    insist(process.argv.length===2,'arguments not allowed');
    const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
    const v=verifyIngressCandidate(root);
    console.log(`PASS: D10 immutable migration ${v.version} pinned SHA256 ${v.sha256}`);
    console.log('PASS: original D9 SQL, protected Git blobs, closed server routes unchanged');
    console.log('PUBLIC LAUNCH: NO_GO | candidate only, prelaunch ingress is UNMOUNTED');
  }catch(e){console.error(e instanceof Error?e.message:'REFUSE_D10_SOURCE: unknown failure');process.exitCode=1;}
}
