import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHiddenTerminalToken, readTokenFromDescriptor, OperatorTokenInputError } from './operator-token-input.js';

function token() { return randomBytes(32).toString('base64url'); }
class FakeTty extends EventEmitter {
  isTTY = true;
  isRaw = false;
  changes: boolean[] = [];
  setRawMode(raw: boolean) { this.isRaw = raw; this.changes.push(raw); }
  resume() {}
  pause() {}
}

function closeConsumedDescriptor(fd: number): void {
  try { closeSync(fd); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error; }
}

const output = (value: string[]) => ({ write(x: string | Uint8Array): boolean { value.push(String(x)); return true; } });

test('D14 hidden terminal reads a 43-byte token, never echoes characters and restores mode', async () => {
  const tty = new FakeTty();
  const printed: string[] = [];
  const secret = token();
  const promise = readHiddenTerminalToken(tty, output(printed) as never, 1000);
  tty.emit('data', Buffer.from(secret + '\r'));
  assert.equal(await promise, secret);
  assert.deepEqual(tty.changes, [true, false]);
  assert.equal(tty.isRaw, false);
  assert.equal(printed.some(x => x.includes(secret)), false);
});

test('D14 terminal backspace works without echo', async () => {
  const tty = new FakeTty();
  const secret = token();
  const p = readHiddenTerminalToken(tty, output([]) as never, 1000);
  tty.emit('data', Buffer.from(secret.slice(0, 15) + 'X\x7f' + secret.slice(15) + '\n'));
  assert.equal(await p, secret);
  assert.equal(tty.isRaw, false);
});

test('D14 refuses terminal with echo enabled or unusable input', async () => {
  const tty = new FakeTty();
  tty.isTTY = false;
  assert.throws(() => readHiddenTerminalToken(tty, output([]) as never, 1000), OperatorTokenInputError);
});

test('D14 Ctrl-C and pasted trailing bytes fail closed and restore raw state', async () => {
  for (const content of ['\x03', token() + '\nINJECT', token() + '\x1b', 'bad\n']) {
    const tty = new FakeTty();
    const printed: string[] = [];
    const p = readHiddenTerminalToken(tty, output(printed) as never, 1000);
    tty.emit('data', Buffer.from(content));
    await assert.rejects(p, OperatorTokenInputError);
    assert.equal(tty.isRaw, false);
    assert.equal(printed.includes(content), false);
  }
});

test('D14 timeout refuses incomplete token and restores terminal state', async () => {
  const tty = new FakeTty();
  const p = readHiddenTerminalToken(tty, output([]) as never, 500);
  tty.emit('data', Buffer.from(token().slice(0, 20)));
  await assert.rejects(p, OperatorTokenInputError);
  assert.equal(tty.isRaw, false);
});

async function fileFixture(fn: (filename: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-d14-fd-'));
  try { await fn(join(root, 'secret')); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('D14 owner-only FD input accepts one canonical token and newline on EOF', async () => {
  await fileFixture(async path => {
    const secret = token();
    await writeFile(path, secret + '\n', { mode: 0o600 });
    const fd = openSync(path, 'r');
    try { assert.equal(await readTokenFromDescriptor(fd, 1000), secret); }
    finally { closeConsumedDescriptor(fd); }
  });
});

test('D14 owner-only FD input rejects world-readable regular files', async () => {
  await fileFixture(async path => {
    await writeFile(path, token(), { mode: 0o600 });
    await chmod(path, 0o644);
    const fd = openSync(path, 'r');
    try { await assert.rejects(readTokenFromDescriptor(fd, 1000), OperatorTokenInputError); }
    finally { closeConsumedDescriptor(fd); }
  });
});

test('D14 FD input refuses additional lines, padded, short or oversized tokens', async () => {
  for (const value of [token() + '\nextra', token() + '=', 'short\n', token() + '\n\n', token() + '\n'.repeat(50)]) {
    await fileFixture(async path => {
      await writeFile(path, value, { mode: 0o600 });
      const fd = openSync(path, 'r');
      try { await assert.rejects(readTokenFromDescriptor(fd, 1000), OperatorTokenInputError); }
      finally { closeConsumedDescriptor(fd); }
    });
  }
});

test('D14 FD reader rejects invalid descriptors and timeout settings', async () => {
  await assert.rejects(readTokenFromDescriptor(-1), OperatorTokenInputError);
  await assert.rejects(readTokenFromDescriptor(2), OperatorTokenInputError);
  await assert.rejects(readTokenFromDescriptor(99999), OperatorTokenInputError);
  await assert.rejects(readTokenFromDescriptor(3, 25), OperatorTokenInputError);
});
