/**
 * Pulse Metrics D14 — opt-in, local-only enrollment secret input.
 *
 * No token in argv, env, URL, shell history or logs. Hidden TTY mode disables
 * terminal echo; descriptor mode accepts an explicitly selected pipe/socket or
 * an owner-only 0600 regular file. Neither mode supplies a fallback secret.
 */
import { createReadStream, fstatSync } from 'node:fs';
import { isCanonicalMachineSecret } from '../security/machine-identity.js';

export class OperatorTokenInputError extends Error {
  constructor() { super('Secure enrollment token input unavailable'); }
}

function fail(): never { throw new OperatorTokenInputError(); }

export interface HiddenTerminalInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode(raw: boolean): unknown;
  on(event: string, handler: (...args: any[]) => void): unknown;
  removeListener(event: string, handler: (...args: any[]) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * Require an interactive terminal; use raw mode so pasted secrets are never
 * echoed. Do not enable bracketed-paste sequences, autocomplete or history.
 */
export function readHiddenTerminalToken(
  terminal: HiddenTerminalInput = process.stdin,
  output: Pick<NodeJS.WriteStream, 'write'> = process.stderr,
  timeoutMs = 90000,
): Promise<string> {
  if (!terminal?.isTTY || typeof terminal.setRawMode !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 120000) fail();
  return new Promise((resolve, reject) => {
    const originalRaw = terminal.isRaw === true;
    let done = false;
    let data = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value?: string) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      terminal.removeListener('data', onData);
      terminal.removeListener('end', onEnd);
      terminal.removeListener('error', onEnd);
      try { terminal.setRawMode(originalRaw); } catch { value = undefined; }
      terminal.pause();
      try { output.write('\n'); } catch { /* no secret written */ }
      data = '';
      if (value && isCanonicalMachineSecret(value)) resolve(value);
      else reject(new OperatorTokenInputError());
    };
    const onEnd = () => finish();
    const onData = (part: unknown) => {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(String(part), 'utf8');
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === 3 || b === 4 || b === 0 || b === 27) { finish(); return; }
        if (b === 127 || b === 8) { data = data.slice(0, -1); continue; }
        if (b === 13 || b === 10) {
          // Refuse trailing pasted bytes after Enter instead of discarding them.
          if (i + 1 < bytes.length && !(b === 13 && i + 2 === bytes.length && bytes[i + 1] === 10)) {
            finish(); return;
          }
          finish(data);
          return;
        }
        if (b < 33 || b > 126 || data.length >= 43) { finish(); return; }
        data += String.fromCharCode(b);
      }
    };
    try {
      terminal.setRawMode(true);
      terminal.on('data', onData);
      terminal.on('end', onEnd);
      terminal.on('error', onEnd);
      timer = setTimeout(() => finish(), timeoutMs);
      output.write('Paste one-time enrollment token (hidden), then Enter: ');
      terminal.resume();
    } catch { finish(); }
  });
}

/**
 * Read exactly one bounded token from an explicitly opened FD, only on EOF.
 * FD 0 must be redirected (not a terminal). The CLI allows only FD 0 or 3.
 * Regular files must be owned by this process and have 0600 permissions.
 */
export async function readTokenFromDescriptor(fd: number, timeoutMs = 30000): Promise<string> {
  if (!Number.isSafeInteger(fd) || (fd !== 0 && (fd < 3 || fd > 1024)) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 120000 ||
      (fd === 0 && process.stdin.isTTY)) fail();
  try {
    const info = fstatSync(fd);
    if (!(info.isFIFO() || info.isSocket() ||
          (info.isFile() && process.platform === 'linux' &&
           typeof process.getuid === 'function' && info.uid === process.getuid() &&
           (info.mode & 0o777) === 0o600 && info.nlink === 1))) fail();
  } catch { fail(); }

  return new Promise<string>((resolve, reject) => {
    let ended = false;
    let bytes = 0;
    const pieces: Buffer[] = [];
    let input: ReturnType<typeof createReadStream>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (token?: string) => {
      if (ended) return;
      ended = true;
      if (timer) clearTimeout(timer);
      input?.destroy();
      for (const p of pieces) p.fill(0);
      if (token && isCanonicalMachineSecret(token)) resolve(token);
      else reject(new OperatorTokenInputError());
    };
    try {
      input = createReadStream('', { fd, autoClose: true, highWaterMark: 64 });
      input.on('data', (part: Buffer | string) => {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        bytes += chunk.length;
        if (bytes > 45) { finish(); return; }
        pieces.push(Buffer.from(chunk));
      });
      input.once('error', () => finish());
      input.once('end', () => {
        const value = Buffer.concat(pieces, bytes).toString('utf8');
        // Exactly one token, with an optional single newline or CRLF.
        const token = value.replace(/\r?\n$/, '');
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { finish(); return; }
        finish(token);
      });
      timer = setTimeout(() => finish(), timeoutMs);
    } catch { finish(); }
  });
}
