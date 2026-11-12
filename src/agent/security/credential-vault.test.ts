import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, chmod, lstat, symlink, link, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  credentialLocation,
  installMachineCredential,
  readMachineCredential,
  rotateMachineCredential,
  MachineCredentialStorageError,
} from './credential-vault.js';

const ORG = 'a9827cff-c4a4-4c36-8ec0-dae0e9933d08';
const AGENT = '153bd92f-47c4-4de2-95e0-a042ea8bcb3a';
const expected = { organizationId: ORG, agentId: AGENT };
const receipt = () => ({ organizationId: ORG, agentId: AGENT,
  machineCredential: randomBytes(32).toString('base64url') });

async function environment(operation: (dir: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-d11-'));
  try { await operation(join(root, 'credential')); }
  finally { await rm(root, { recursive: true, force: true }); }
}

const linuxOnly = { skip: process.platform !== 'linux' };

test('first installation makes owner-only directory and owner-only credential', linuxOnly, async () => {
  await environment(async (dir) => {
    const value = receipt();
    await installMachineCredential(dir, value, expected);
    assert.deepEqual(await readMachineCredential(dir), value);
    const parent = await lstat(dir);
    const file = await lstat(credentialLocation(dir));
    assert.equal(parent.mode & 0o777, 0o700);
    assert.equal(file.mode & 0o777, 0o600);
    assert.equal(file.nlink, 1);
    assert.equal(JSON.parse(await readFile(credentialLocation(dir), 'utf8')).organizationId, ORG);
  });
});

test('first install refuses mismatched expected organization or agent before creating files', linuxOnly, async () => {
  await environment(async (dir) => {
    const value = receipt();
    await assert.rejects(installMachineCredential(dir, value, {
      organizationId: '3ab79abc-899d-43a7-bf8a-784214289845', agentId: AGENT,
    }), TypeError);
    await assert.rejects(readMachineCredential(dir), MachineCredentialStorageError);
  });
});

test('second installation refuses to overwrite an existing credential', linuxOnly, async () => {
  await environment(async (dir) => {
    const first = receipt();
    await installMachineCredential(dir, first, expected);
    await assert.rejects(installMachineCredential(dir, receipt(), expected), MachineCredentialStorageError);
    assert.deepEqual(await readMachineCredential(dir), first);
  });
});

test('explicit compare-and-swap rotation replaces only the expected secret', linuxOnly, async () => {
  await environment(async (dir) => {
    const first = receipt();
    const second = receipt();
    await installMachineCredential(dir, first, expected);
    await assert.rejects(rotateMachineCredential(dir, receipt().machineCredential, second), MachineCredentialStorageError);
    assert.deepEqual(await readMachineCredential(dir), first);
    await rotateMachineCredential(dir, first.machineCredential, second);
    assert.deepEqual(await readMachineCredential(dir), second);
    assert.equal((await lstat(credentialLocation(dir))).mode & 0o777, 0o600);
  });
});

test('rotation will not swap organization or agent identity', linuxOnly, async () => {
  await environment(async (dir) => {
    const first = receipt();
    await installMachineCredential(dir, first, expected);
    await assert.rejects(rotateMachineCredential(dir, first.machineCredential, {
      ...receipt(), organizationId: '3ab79abc-899d-43a7-bf8a-784214289845',
    }), MachineCredentialStorageError);
    assert.deepEqual(await readMachineCredential(dir), first);
  });
});

test('refuses group/other readable credentials without silently chmodding them', linuxOnly, async () => {
  await environment(async (dir) => {
    await installMachineCredential(dir, receipt(), expected);
    await chmod(credentialLocation(dir), 0o644);
    await assert.rejects(readMachineCredential(dir), MachineCredentialStorageError);
    assert.equal((await lstat(credentialLocation(dir))).mode & 0o777, 0o644);
  });
});

test('refuses group-accessible private directory', linuxOnly, async () => {
  await environment(async (dir) => {
    await installMachineCredential(dir, receipt(), expected);
    await chmod(dir, 0o750);
    await assert.rejects(readMachineCredential(dir), MachineCredentialStorageError);
  });
});

test('refuses symlink directory and symlink target', linuxOnly, async () => {
  await environment(async (dir) => {
    const other = dir + '-target';
    await mkdir(other, { mode: 0o700 });
    await symlink(other, dir);
    await assert.rejects(installMachineCredential(dir, receipt(), expected), MachineCredentialStorageError);
  });
  await environment(async (dir) => {
    await mkdir(dir, { mode: 0o700 });
    await symlink(join(dir, 'nonexistent'), credentialLocation(dir));
    await assert.rejects(installMachineCredential(dir, receipt(), expected), MachineCredentialStorageError);
  });
});

test('refuses hard-linked credential files', linuxOnly, async () => {
  await environment(async (dir) => {
    await installMachineCredential(dir, receipt(), expected);
    await link(credentialLocation(dir), join(dir, 'second-name'));
    await assert.rejects(readMachineCredential(dir), MachineCredentialStorageError);
  });
});

test('refuses malformed stored JSON and never returns its bytes in an error', linuxOnly, async () => {
  await environment(async (dir) => {
    await installMachineCredential(dir, receipt(), expected);
    await writeFile(credentialLocation(dir), '{"secret":"not-a-token"}', { mode: 0o600 });
    await assert.rejects(readMachineCredential(dir), (error: unknown) => {
      assert.equal(String(error).includes('not-a-token'), false);
      return true;
    });
  });
});

test('refuses a pending rotation lock instead of bypassing concurrent mutation', linuxOnly, async () => {
  await environment(async (dir) => {
    const value = receipt();
    await installMachineCredential(dir, value, expected);
    await writeFile(join(dir, '.machine-identity.lock'), '', { flag: 'wx', mode: 0o600 });
    await assert.rejects(rotateMachineCredential(dir, value.machineCredential, receipt()), MachineCredentialStorageError);
    assert.deepEqual(await readMachineCredential(dir), value);
  });
});

test('refuses relative paths and missing credential storage', linuxOnly, async () => {
  await assert.rejects(readMachineCredential('relative/unsafe'), MachineCredentialStorageError);
  await environment(async (dir) => {
    await assert.rejects(readMachineCredential(dir), MachineCredentialStorageError);
  });
});

test('no credential or token is ever printed to stdout by the storage primitive', linuxOnly, async () => {
  await environment(async (dir) => {
    const value = receipt();
    const original = console.log;
    const outputs: unknown[][] = [];
    console.log = (...args: unknown[]) => { outputs.push(args); };
    try {
      await installMachineCredential(dir, value, expected);
      await readMachineCredential(dir);
      await rotateMachineCredential(dir, value.machineCredential, receipt());
    } finally { console.log = original; }
    assert.equal(outputs.length, 0);
  });
});
