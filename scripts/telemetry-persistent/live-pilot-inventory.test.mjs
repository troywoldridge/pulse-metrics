import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyEmptySnapshotText } from './validate-live-pilot-inventory.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const sh = join(dir, 'guarded-live-inventory.sh');
const sqlFile = join(dir, 'pilot-live-inventory.sql');
const validator = join(dir, 'validate-live-pilot-inventory.mjs');
const shell = readFileSync(sh, 'utf8');
const sql = readFileSync(sqlFile, 'utf8');
const fixture = () => ({
  version: 1, organizationIds: [], userCount: 0, membershipCount: 0,
  agents: [], credentials: [], sampleCount: 0, submissionCount: 0,
  samplesByAgent: [], orphanSamples: 0, mismatchedLedger: 0,
  unownedTelemetry: 0, unscopedVisibleSamples: 0, rlsViolations: 0,
  unsafeRoles: 0, migrationReceiptErrors: 0,
  runtimeCredentialRead: false, runtimeDirectTelemetryInsert: false,
});
const json = value => `${JSON.stringify(value)}\n`;
function run(args=[], envChanges={}) {
  const env={...process.env, NODE_ENV:'development', NODE_OPTIONS:'',
    NODE_EXTRA_CA_CERTS:'', NODE_TLS_REJECT_UNAUTHORIZED:'1',
    DATABASE_URL:'', MIGRATION_DATABASE_URL:'',
    PULSE_APPROVE_5U2F2H_LIVE_EMPTY_INVENTORY:'',
    PULSE_APPROVE_5U2F_LOCAL_START:'',
    PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE:'',
    ...envChanges};
  return spawnSync('bash',[sh,...args],{encoding:'utf8',env,timeout:5000});
}
function cli(args,input) {
  return spawnSync('node',[validator,...args],{input,encoding:'utf8',timeout:5000});
}
function reject(value) {
  assert.throws(()=>verifyEmptySnapshotText(json(value)),/REFUSE_D15C5U2F2G_POLICY|REFUSE_D15C5U2F2H/);
}

test('2F2H full Bash, SQL and JS are present and parse',()=>{
  assert.equal(spawnSync('bash',['-n',sh],{encoding:'utf8'}).status,0);
  assert.equal(spawnSync('node',['--check',validator],{encoding:'utf8'}).status,0);
  assert.ok(sql.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'));
  assert.match(sql,/COMMIT;\s*$/);
});
test('2F2H plan never starts or connects to PostgreSQL',()=>{
  const p=run(['--plan']);
  if(process.getuid?.()===0){
    assert.notEqual(p.status,0);
    assert.match(p.stderr,/Linux non-root operator required/);
  } else {
    assert.equal(p.status,0,p.stderr);
    assert.match(p.stdout,/NO DATABASE STARTED BY PLAN/);
    assert.match(p.stdout,/NO DATABASE STARTED BY PLAN|NO POSTGRESQL STARTED BY PLAN/);
    assert.match(p.stdout,/PERSISTENT WRITES: NOT APPROVED/);
  }
});
test('2F2H rejects missing, invalid, multiple or nonempty-mode arguments',()=>{
  for (const args of [[],['--start'],['--bounded'],['--write'],['--exercise-empty','--verify'],['--verify','--verify']]) {
    const p=run(args);
    assert.notEqual(p.status,0);
    assert.match(p.stderr,/REFUSE_D15C5U2F2H/);
  }
});
test('2F2H requires a separate exact empty-only approval before any start',()=>{
  if(process.getuid?.()===0) return;
  for(const approval of ['', 'YES', 'START_READ_ONLY_SNAPSHOT_STOP_WRITES']){
    const p=run(['--exercise-empty'],{PULSE_APPROVE_5U2F2H_LIVE_EMPTY_INVENTORY:approval});
    assert.notEqual(p.status,0);
    assert.match(p.stderr,/Separate exact live empty-inventory approval required/);
  }
  const p=run(['--verify'],{PULSE_APPROVE_5U2F2H_LIVE_EMPTY_INVENTORY:'START_READ_ONLY_SNAPSHOT_STOP'});
  assert.notEqual(p.status,0);
  assert.match(p.stderr,/Approval permitted only/);
});
test('2F2H refuses production, DB redirects, inherited approvals and TLS bypass',()=>{
  if(process.getuid?.()===0) return;
  for (const bad of [
    {NODE_ENV:'production'}, {DATABASE_URL:'postgres://example'},
    {PGHOST:'evil'}, {NODE_OPTIONS:'--inspect'},
    {NODE_EXTRA_CA_CERTS:'/tmp/evil'}, {NODE_TLS_REJECT_UNAUTHORIZED:'0'},
    {PULSE_ENABLE_PUBLIC_INGRESS:'YES'},
    {PULSE_APPROVE_5U2F_LOCAL_START:'EXACT_SOCKET_ONLY'},
    {PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE:'START_AUDIT_STOP_NO_WRITES'},
  ]) {
    const p=run(['--verify'],bad);
    assert.notEqual(p.status,0);
    assert.match(p.stderr,/REFUSE_D15C5U2F2H/);
  }
});
test('2F2H original operator and snapshot sources are pinned by SHA256',()=>{
  for(const marker of [
    '6286727b0ee8720a539f46aa2f87b87c84c013afd782099ba8bceae6ded34c3b',
    'b81e5c0c4ceda47a2c2f9a5c0fd4c8dd158895c7519290ff914204241b289e6a',
    '332c10803dbf674c2ad31e6fe2c44ac9c143f296228b430853fe416a73ed1a41',
    '9c615fec37b03276bcefe46e9224e2e26e1434b5719d096fe25edc6cf890c713',
    '2ed0add299167d54db960502438ca908d223cddd0a1badab275dd6690d3b3474',
  ]) assert.ok(shell.includes(marker));
});
test('2F2H SQL has immutable exact local socket and PostgreSQL target identity',()=>{
  for(const target of [
    "/var/lib/postgresql/pulse-metrics-dev-5u2/data",
    "/var/lib/postgresql/pulse-metrics-dev-5u2/socket",
    "current_setting('port') <> '55433'",
    "current_setting('listen_addresses') <> ''",
    "inet_server_addr() IS NOT NULL",
    "current_user <> 'postgres'",
    "current_setting('transaction_read_only') <> 'on'",
  ]) assert.ok(sql.includes(target),target);
});
test('2F2H SQL refuses private ancillary data as well as user/agent/sample data',()=>{
  for(const table of [
    'public.agent_enrollment_tokens','public.organization_invitations',
    'public.invitation_rate_limits','public.audit_events',
    'pulse_telemetry_ingestion.submissions',
    'pulse_telemetry_quota.network_buckets',
    'pulse_telemetry_agent_quota.agent_buckets',
    'public.telemetry_samples', 'public.users', 'public.monitored_agents',
  ]) assert.ok(sql.includes(`EXISTS (SELECT 1 FROM ${table})`),table);
});
test('2F2H SQL tests effective unscoped RLS in one read-only snapshot',()=>{
  for(const token of [
    'SET LOCAL ROLE pulse_metrics_app;',
    'FROM public.telemetry_samples \\gset',
    'RESET ROLE;',
    "'unscopedVisibleSamples', :'unscoped_visible'::bigint",
    'REPEATABLE READ READ ONLY',
  ]) assert.ok(sql.includes(token),token);
});
test('2F2H SQL inventory is bidirectionally ledger and tenant-bound',()=>{
  for(const token of [
    "'orphanSamples'", "'mismatchedLedger'", "'unownedTelemetry'",
    's.telemetry_sample_id=t.id', 't.id=s.telemetry_sample_id',
    'a.id=t.agent_id AND a.organization_id=t.organization_id',
    "'runtimeCredentialRead'", "'runtimeDirectTelemetryInsert'",
    "'unsafeRoles'", "'rlsViolations'", "'migrationReceiptErrors'",
  ]) assert.ok(sql.includes(token),token);
});
test('2F2H SQL has no writes or DDL and does not output secrets',()=>{
  const code=sql.replace(/--[^\n]*/g,'');
  assert.doesNotMatch(code,/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|DROP|ALTER|COPY|GRANT|REVOKE)\s+(?:INTO|TABLE|FROM|ROLE|FUNCTION|SCHEMA|ON)\b/i);
  assert.doesNotMatch(code,/\b(?:token_hash|token_prefix|payload_sha256|secret|password|credential_hash)\b/i);
  assert.match(shell,/sudo -u postgres.*PG_BIN\/psql/);
  assert.match(shell,/PULSE_APPROVE_5U2F_LOCAL_START=EXACT_SOCKET_ONLY bash "\$OLD" --start/);
  assert.match(shell,/bash "\$OLD" --stop/);
});
test('2F2H accepts exactly the expected empty nonsecret inventory shape',()=>{
  assert.deepEqual(verifyEmptySnapshotText(json(fixture())),
    {mode:'empty',sampleCount:0,agentCount:0});
  const p=cli(['--empty-stdin'],json(fixture()));
  assert.equal(p.status,0,p.stderr);
  assert.match(p.stdout,/PASS: exact read-only PostgreSQL inventory/);
  assert.doesNotMatch(p.stdout,/organizationId|agentId|credential|tokenHash/);
});
test('2F2H refuses nonempty and forged or weakened inventory',()=>{
  for(const [field,value] of [
    ['userCount',1],['membershipCount',1],['sampleCount',1],
    ['submissionCount',1],['orphanSamples',1],['mismatchedLedger',1],
    ['unownedTelemetry',1],['unscopedVisibleSamples',1],['rlsViolations',1],
    ['unsafeRoles',1],['migrationReceiptErrors',1],
    ['runtimeCredentialRead',true],['runtimeDirectTelemetryInsert',true],
  ]) {const x=fixture();x[field]=value;reject(x);}
  const x=fixture();x.key='secret';reject(x);
  const a=fixture();a.organizationIds=['b5ab11cb-8784-4de3-873c-a9fdacfd083c'];reject(a);
});
test('2F2H validator fails closed on malformed, repeated or excessive output',()=>{
  for(const x of ['','{}','not-json','\n{}\n{}\n','{"secret":"token"}',
    json(fixture())+json(fixture()),'x'.repeat(17000)]){
    const p=cli(['--empty-stdin'],x);
    assert.notEqual(p.status,0);
    assert.match(p.stderr,/REFUSE_D15C5U2F2H|REFUSE_D15C5U2F2G_POLICY/);
  }
  const p=cli(['--bounded'],json(fixture()));
  assert.notEqual(p.status,0);
});

test('2F2H psql reads pinned locked FD9 as stdin, never reopens SQL as postgres',()=>{
  assert.match(shell,/exec 9< "\$SQL"/);
  assert.match(shell,/flock -n 9/);
  assert.match(shell,/INVENTORY="\$\(sudo -u postgres "\$PG_BIN\/psql" -X -Atq[\s\S]*?-d pulse_metrics \\\n  <&9\)" \|\| refuse/);
  // The only psql command is the stdin-fed one; no executable -f path.
  const command=shell.slice(shell.indexOf('INVENTORY="$(sudo -u postgres'));
  assert.doesNotMatch(command,/-f\s+"\$SQL"/);
  assert.doesNotMatch(command,/-f\s+"?scripts\/telemetry-persistent\/pilot-live-inventory/);
});
test('2F2H owner-only SQL can be streamed from inherited FD without exposing path',()=>{
  const base=mkdtempSync(join(tmpdir(),'pulse-2f2h-fd-'));
  try {
    chmodSync(base,0o700);
    const p=join(base,'protected.sql');
    const sqlText='SELECT 1 AS operator_file_descriptor_test;\n';
    writeFileSync(p,sqlText,{mode:0o600});
    const r=spawnSync('bash',['-c',
      'set -euo pipefail; exec 9< "$1"; flock -n 9; cat <&9',
      'bash',p],{encoding:'utf8',timeout:5000});
    assert.equal(r.status,0,r.stderr);
    assert.equal(r.stdout,sqlText);
  } finally { rmSync(base,{recursive:true,force:true}); }
});

test('2F2H self-tests strip live approval, and cleanup is mandatory',()=>{
  assert.match(shell,/env -u PULSE_APPROVE_5U2F2H_LIVE_EMPTY_INVENTORY/);
  assert.match(shell,/trap cleanup EXIT/);
  assert.match(shell,/bash "\$OFFLINE" \|\| code=1/);
  assert.match(shell,/bash "\$BACKUP" --verify \|\| code=1/);
  assert.match(shell,/START_ATTEMPTED=1/);
  assert.match(shell,/PERSISTENT TELEMETRY WRITES: NOT APPROVED/);
});
