/**
 * D15C-5N — local-only historical read preview startup policy.
 *
 * No database connection, HTTP listener, or implicit environment activation.
 * This policy is not a production authorization mechanism.
 */
export interface LocalHistoryPreviewConfig {
  readonly port: number;
  readonly bindAddress: '127.0.0.1';
}

export class LocalHistoryPreviewDenied extends Error {
  constructor() {
    super('D15C-5N local history preview is not authorized');
    this.name = 'LocalHistoryPreviewDenied';
  }
}

function refuse(): never {
  throw new LocalHistoryPreviewDenied();
}

/**
 * An explicit two-part development-only opt-in plus a fixed local database.
 * Reject query-string connection overrides, alternate ports, and SSH tunnels.
 * The preview must never be used with production or external databases.
 */
export function requireLocalHistoryPreview(
  environment: Readonly<NodeJS.ProcessEnv>,
): LocalHistoryPreviewConfig {
  if (
    environment.NODE_ENV !== 'development' ||
    environment.PULSE_HISTORY_PREVIEW !== 'read-only'
  ) return refuse();

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(environment.DATABASE_URL ?? '');
  } catch {
    return refuse();
  }

  if (
    !['postgresql:', 'postgres:'].includes(databaseUrl.protocol) ||
    databaseUrl.username !== 'pulse_metrics_app' ||
    !['localhost', '127.0.0.1'].includes(databaseUrl.hostname.toLowerCase()) ||
    databaseUrl.port !== '5432' ||
    databaseUrl.pathname !== '/pulse_metrics' ||
    databaseUrl.search !== '' ||
    databaseUrl.hash !== ''
  ) return refuse();

  const requestedPort = environment.PULSE_HISTORY_PREVIEW_PORT ?? '3077';
  if (!/^[1-9][0-9]{3,4}$/.test(requestedPort)) return refuse();
  const port = Number(requestedPort);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || port === 5432) {
    return refuse();
  }

  return Object.freeze({ bindAddress: '127.0.0.1', port });
}
