/**
 * D14 opt-in operator enrollment CLI. NOT invoked by server.ts or agent runner.
 *
 * Syntax (all values except token are nonsecret):
 * node --import tsx src/agent/enrollment/operator-cli.ts \\
 *   --origin https://monitor.example --organization-id UUID --agent-id UUID \\
 *   --credential-dir /safe/absolute/directory --display-name 'Machine' \\
 *   --hostname machine.example --architecture x86_64 [--token-source tty|stdin|fd3]
 *
 * Source defaults to a hidden terminal prompt, with no echo or shell history.
 */
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseAgentDescription } from '../../server/agent-credential-policy.js';
import { isCanonicalMachineSecret } from '../security/machine-identity.js';
import { enrollWithOperatorToken, OperatorEnrollmentError } from './operator-enrollment.js';
import { readHiddenTerminalToken, readTokenFromDescriptor } from './operator-token-input.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = new Set(['--origin','--organization-id','--agent-id','--credential-dir',
  '--display-name','--hostname','--architecture','--token-source','--trusted-ca-file']);

export interface OperatorCliOptions {
  readonly expectedOrigin: string;
  readonly expectedOrganizationId: string;
  readonly expectedAgentId: string;
  readonly credentialDirectory: string;
  readonly agent: { displayName: string; hostname: string; platform: 'linux'; architecture: 'x86_64' | 'aarch64' };
  readonly tokenSource: 'tty' | 'stdin' | 'fd3';
  readonly trustedCaFile?: string;
}

function fail(): never { throw new OperatorEnrollmentError(); }

/** Reject unknown flags, duplicates, option injection, embedded secrets. */
export function parseOperatorArgs(argv: readonly string[]): OperatorCliOptions {
  if (argv.length % 2 || argv.length < 14 || argv.length > 18 ||
      argv.some(value => isCanonicalMachineSecret(value))) fail();
  const fields: Record<string, string> = Object.create(null);
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!FIELDS.has(name) || fields[name] !== undefined ||
        typeof value !== 'string' || !value || value.startsWith('--') ||
        /[\x00-\x1f\x7f]/.test(value)) fail();
    fields[name] = value;
  }
  const src = fields['--token-source'] ?? 'tty';
  if (!['tty','stdin','fd3'].includes(src) ||
      !UUID.test(fields['--organization-id'] ?? '') ||
      !UUID.test(fields['--agent-id'] ?? '')) fail();
  const dir = fields['--credential-dir'];
  if (!dir || !isAbsolute(dir) || normalize(dir) !== dir || dir === '/' || dir.endsWith('/') || dir.length > 2048) fail();
  const agent = parseAgentDescription({ displayName: fields['--display-name'],
    hostname: fields['--hostname'], architecture: fields['--architecture'], platform: 'linux' });
  if (!agent) fail();
  const origin = fields['--origin'];
  let parsed: URL;
  try { parsed = new URL(origin); } catch { fail(); }
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.pathname !== '/' ||
      parsed.search || parsed.hash || parsed.username || parsed.password) fail();
  const ca = fields['--trusted-ca-file'];
  if (ca !== undefined && (!isAbsolute(ca) || normalize(ca) !== ca || ca.length > 2048)) fail();
  return { expectedOrigin: origin,
    expectedOrganizationId: fields['--organization-id'], expectedAgentId: fields['--agent-id'],
    credentialDirectory: dir, agent, tokenSource: src as OperatorCliOptions['tokenSource'],
    ...(ca ? { trustedCaFile: ca } : {}) };
}

/** No tokens in diagnostics; no flags enable TLS bypass or retries. */
export async function mainOperatorCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    if (process.platform !== 'linux') fail();
    const config = parseOperatorArgs(argv);
    let trustedCaPem: string | undefined;
    if (config.trustedCaFile) {
      const info = await lstat(config.trustedCaFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16384 || info.size < 64) fail();
      trustedCaPem = await readFile(config.trustedCaFile, 'utf8');
    }
    const result = await enrollWithOperatorToken({
      expectedOrigin: config.expectedOrigin,
      expectedOrganizationId: config.expectedOrganizationId,
      expectedAgentId: config.expectedAgentId,
      credentialDirectory: config.credentialDirectory,
      agent: config.agent,
      ...(trustedCaPem ? { trustedCaPem } : {}),
    }, () => config.tokenSource === 'tty' ? readHiddenTerminalToken() :
      readTokenFromDescriptor(config.tokenSource === 'stdin' ? 0 : 3));
    // No credential, enrollment token or private path is printed.
    process.stdout.write(JSON.stringify({ status: 'enrolled', organizationId: result.organizationId,
      agentId: result.agentId }) + '\n');
    return 0;
  } catch {
    process.stderr.write('ERROR: Operator enrollment unavailable; do not retry blindly. Reconcile token and agent status with the control plane.\n');
    return 1;
  }
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  void mainOperatorCli().then(code => { process.exitCode = code; }, () => {
    process.stderr.write('ERROR: Operator enrollment unavailable.\n');
    process.exitCode = 1;
  });
}
