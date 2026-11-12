/**
 * Phase 2E3C5D11 — Linux-only, local machine credential custody foundation.
 *
 * This is an UNMOUNTED filesystem primitive. It never enrolls a machine,
 * connects to an API, handles TLS, or prints its secret. In production the
 * caller must verify HTTPS, expected organization/agent identity, and the
 * credential's server-side state before calling install/rotate.
 *
 * The target is an owner-only (0700) directory and a regular 0600 file.
 * All mutation is lock-serialized and staged in an exclusive temporary file.
 * A crash can leave a lock; it must be investigated, not silently removed.
 */
import {
  constants as fsConstants,
  promises as fs,
} from 'node:fs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join, normalize, parse, sep } from 'node:path';
import {
  assertExpectedMachineIdentity,
  isCanonicalMachineSecret,
  parseMachineIdentity,
  type MachineIdentity,
} from './machine-identity.js';

const FILE_NAME = 'machine-identity.json';
const LOCK_NAME = '.machine-identity.lock';
const MAX_BYTES = 512;
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fsConstants;

export class MachineCredentialStorageError extends Error {
  constructor() { super('Machine credential storage unavailable'); }
}

function deny(): never { throw new MachineCredentialStorageError(); }

function uid(): number {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') deny();
  return process.getuid();
}

function validateDirectoryName(directory: unknown): string {
  if (typeof directory !== 'string' || directory.length < 2 || directory.length > 2048 ||
      !isAbsolute(directory) || directory !== normalize(directory) ||
      directory.includes('\0') || directory.endsWith(sep)) deny();
  if (directory === parse(directory).root) deny();
  return directory;
}

async function inspectAncestors(directory: string): Promise<void> {
  const root = parse(directory).root;
  let current = root;
  const relative = directory.slice(root.length).split(sep).filter(Boolean);
  for (const segment of relative.slice(0, -1)) {
    current = join(current, segment);
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) deny();
    // Root-owned sticky directories such as /tmp are safe shared parents.
    const sharedWritable = (info.mode & 0o022) !== 0;
    const rootSticky = info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (sharedWritable && !rootSticky) deny();
  }
}

async function secureDirectory(directory: string, create: boolean): Promise<void> {
  uid();
  validateDirectoryName(directory);
  await inspectAncestors(directory);
  if (create) {
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid() ||
      (info.mode & 0o777) !== 0o700) deny();
  // Opening the directory without following links narrows path-swap attacks.
  const fd = await fs.open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    const opened = await fd.stat();
    if (!opened.isDirectory() || opened.ino !== info.ino || opened.dev !== info.dev) deny();
  } finally { await fd.close(); }
}

async function existingFile(directory: string): Promise<boolean> {
  const name = join(directory, FILE_NAME);
  try {
    const info = await fs.lstat(name);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
        info.uid !== uid() || (info.mode & 0o777) !== 0o600) deny();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readValidated(directory: string): Promise<MachineIdentity> {
  if (!await existingFile(directory)) deny();
  const fd = await fs.open(join(directory, FILE_NAME), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== uid() ||
        (info.mode & 0o777) !== 0o600 || info.size <= 0 || info.size > MAX_BYTES) deny();
    const buffer = Buffer.alloc(info.size);
    const result = await fd.read(buffer, 0, info.size, 0);
    if (result.bytesRead !== info.size) deny();
    let parsed: unknown;
    try { parsed = JSON.parse(buffer.toString('utf8')); }
    catch { deny(); }
    return parseMachineIdentity(parsed);
  } finally { await fd.close(); }
}

function sameSecret(first: string, second: string): boolean {
  if (!isCanonicalMachineSecret(first) || !isCanonicalMachineSecret(second)) return false;
  const firstDigest = createHash('sha256').update(first).digest();
  const secondDigest = createHash('sha256').update(second).digest();
  return timingSafeEqual(firstDigest, secondDigest);
}

async function lockDirectory(directory: string): Promise<() => Promise<void>> {
  const lockName = join(directory, LOCK_NAME);
  const handle = await fs.open(lockName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== uid() ||
        (info.mode & 0o777) !== 0o600) deny();
    await handle.sync();
  } finally { await handle.close(); }
  return async () => { await fs.unlink(lockName); };
}

async function commitIdentity(directory: string, receipt: MachineIdentity): Promise<void> {
  const target = join(directory, FILE_NAME);
  const tmpName = join(directory, `.${FILE_NAME}.${randomBytes(16).toString('hex')}.tmp`);
  let staged = false;
  try {
    const handle = await fs.open(tmpName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    staged = true;
    try {
      const serialized = Buffer.from(JSON.stringify(receipt) + '\n', 'utf8');
      if (serialized.length > MAX_BYTES) deny();
      await handle.writeFile(serialized);
      await handle.sync();
    } finally { await handle.close(); }
    // Atomic replacement. The exclusive lock serializes cooperating writers.
    await fs.rename(tmpName, target);
    staged = false;
    const dir = await fs.open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    try { await dir.sync(); }
    finally { await dir.close(); }
  } finally {
    if (staged) await fs.unlink(tmpName).catch(() => {});
  }
}

/** Install only once; never overwrite an unknown or existing credential. */
export async function installMachineCredential(
  directory: string,
  receipt: unknown,
  expectedIdentity: { organizationId: string; agentId: string },
): Promise<void> {
  const valid = parseMachineIdentity(receipt);
  // The caller MUST supply its separately verified target identity. Never
  // trust the organization/agent IDs returned by a credential endpoint alone.
  assertExpectedMachineIdentity(valid, expectedIdentity);
  try {
    await secureDirectory(directory, true);
    const unlock = await lockDirectory(directory);
    try {
      if (await existingFile(directory)) deny();
      await commitIdentity(directory, valid);
    } finally { await unlock(); }
  } catch { deny(); }
}

/**
 * Rotation is explicit, never automatic. The caller must supply the previous
 * raw secret from a trusted in-memory source, AND a receipt verified over TLS.
 * The old and new agent identity MUST match; otherwise state stays unchanged.
 */
export async function rotateMachineCredential(
  directory: string,
  expectedPreviousSecret: string,
  replacement: unknown,
): Promise<void> {
  const valid = parseMachineIdentity(replacement);
  if (!isCanonicalMachineSecret(expectedPreviousSecret)) deny();
  try {
    await secureDirectory(directory, false);
    const unlock = await lockDirectory(directory);
    try {
      const old = await readValidated(directory);
      assertExpectedMachineIdentity(valid, { organizationId: old.organizationId, agentId: old.agentId });
      if (!sameSecret(old.machineCredential, expectedPreviousSecret) ||
          sameSecret(old.machineCredential, valid.machineCredential)) deny();
      await commitIdentity(directory, valid);
    } finally { await unlock(); }
  } catch { deny(); }
}

/** Read only; refuses missing, symlinked, hard-linked, or over-permissive files. */
export async function readMachineCredential(directory: string): Promise<MachineIdentity> {
  try {
    await secureDirectory(directory, false);
    return await readValidated(directory);
  } catch { deny(); }
}

/** Returns only metadata. Does not load or disclose machineCredential. */
export function credentialLocation(directory: string): string {
  return join(validateDirectoryName(directory), FILE_NAME);
}
