import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { parseOperatorArgs, mainOperatorCli } from './operator-cli.js';
import { OperatorEnrollmentError } from './operator-enrollment.js';

const ORG = 'a9827cff-c4a4-4c36-8ec0-dae0e9933d08';
const AGENT = '153bd92f-47c4-4de2-95e0-a042ea8bcb3a';
const args = ['--origin','https://example.invalid','--organization-id',ORG,'--agent-id',AGENT,
  '--credential-dir','/var/lib/pulse-agent','--display-name','Operator Machine',
  '--hostname','operator.invalid','--architecture','x86_64'];

test('D14 CLI allows only fixed expected origin, agent details and known token sources', () => {
  const parsed = parseOperatorArgs(args);
  assert.equal(parsed.tokenSource, 'tty');
  assert.equal(parsed.expectedAgentId, AGENT);
  assert.equal(parsed.agent.platform, 'linux');
  assert.equal(parseOperatorArgs([...args,'--token-source','fd3']).tokenSource,'fd3');
  assert.equal(parseOperatorArgs([...args,'--token-source','stdin']).tokenSource,'stdin');
});

test('D14 CLI refuses tokens and credentials in process argv', () => {
  const raw = randomBytes(32).toString('base64url');
  for (const argv of [[...args,'--token',raw], [...args,'--one-time-token',raw],
    [...args,'--token-source',raw], [...args,raw], [...args,'--origin',raw],
    [...args.slice(0,9),raw,...args.slice(10)]]) {
    assert.throws(() => parseOperatorArgs(argv), OperatorEnrollmentError);
  }
});

test('D14 CLI refuses duplicate, unknown and malformed flags', () => {
  for (const argv of [[...args,'--origin','https://different.invalid'],
    [...args,'--unexpected','x'], args.slice(0,-1), [...args,'--token-source','tty','--token-source','fd3']]) {
    assert.throws(() => parseOperatorArgs(argv), OperatorEnrollmentError);
  }
});

test('D14 CLI refuses HTTP, credentials in URLs, and invalid machine identity', () => {
  for (const [index, value] of [[1,'http://example.invalid'],[1,'https://user:pass@example.invalid'],
    [1,'https://example.invalid/path'],[3,'wrong'],[5,'wrong'],[7,'relative/path'],
    [7,'/var/lib/../unsafe'],[13,'armv7']] as const) {
    const argv = args.slice(); argv[index] = value;
    assert.throws(() => parseOperatorArgs(argv), OperatorEnrollmentError);
  }
});

test('D14 invalid CLI fails without requesting token or networking', async () => {
  const original = process.stderr.write;
  const written: string[] = [];
  process.stderr.write = ((part: unknown) => { written.push(String(part)); return true; }) as typeof process.stderr.write;
  try { assert.equal(await mainOperatorCli(['--token','secret']), 1); }
  finally { process.stderr.write = original; }
  assert.equal(written.join('').includes('secret'), false);
});
