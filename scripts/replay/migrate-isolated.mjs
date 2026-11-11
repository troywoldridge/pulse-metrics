// Real Drizzle ORM migration runner, connected exclusively to replay socket.
// No .env, DATABASE_URL, MIGRATION_DATABASE_URL, or external endpoints are used.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const socket = process.env.PULSE_REPLAY_SOCKET;
const dataDirectory = process.env.PULSE_REPLAY_DATA;
const port = Number(process.env.PULSE_REPLAY_PORT);
if (!socket || !/^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/.test(socket) ||
    !dataDirectory || dataDirectory !== socket.replace(/\/socket$/, '/data') ||
    port !== 55432 || process.env.NODE_ENV === 'production') {
  throw new Error('Invalid isolated replay connection configuration.');
}
const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
if (journal.entries?.length !== 1 || journal.entries[0]?.tag !== '0000_damp_tomorrow_man') {
  throw new Error('Unexpected Drizzle journal; baseline migration needs review.');
}
const pool = new pg.Pool({ host: socket, port, user: 'pulse_metrics_migrator',
  database: 'pulse_metrics', ssl: false, connectionTimeoutMillis: 5000,
  max: 1, application_name: 'pulse-isolated-replay' });
try {
  const {rows} = await pool.query(`
    SELECT current_database() AS db, current_user AS role,
           inet_server_addr() IS NULL AS socket_only,
           current_setting('port') AS port
  `);
  const info = rows[0];
  if (info?.db !== 'pulse_metrics' || info?.role !== 'pulse_metrics_migrator' ||
      info?.port !== '55432' || info?.socket_only !== true) {
    throw new Error('Connection not bound to the intended isolated PostgreSQL cluster.');
  }
  console.log('PASS: isolated Unix socket and migrator identity verified (data directory checked by admin wrapper)');
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle'),
    migrationsSchema: 'public', migrationsTable: '__drizzle_migrations' });
  const verify = await pool.query(`SELECT count(*)::integer AS count
    FROM public.__drizzle_migrations`);
  if (verify.rows[0]?.count !== 1) throw new Error('Expected exactly one real Drizzle migration ledger entry.');
  console.log('PASS: original Drizzle migration applied through the real migration runner');
} finally {
  await pool.end();
}
