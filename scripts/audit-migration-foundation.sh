#!/usr/bin/env bash
# Pulse Metrics — Phase 2E3C5A. Read-only security and migration inventory.
# Never creates, migrates, alters, drops or grants anything.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[[ -f .env ]] || { echo 'ERROR: local .env is required' >&2; exit 1; }
command -v node >/dev/null || { echo 'ERROR: node is required' >&2; exit 1; }
command -v sudo >/dev/null || { echo 'ERROR: sudo is required' >&2; exit 1; }
command -v psql >/dev/null || { echo 'ERROR: psql is required' >&2; exit 1; }
command -v sha256sum >/dev/null || { echo 'ERROR: sha256sum is required' >&2; exit 1; }

# Read only the URL's host/database/username, NEVER echo URL/password.
node --env-file=.env --input-type=module <<'NODE'
import { readFileSync, readdirSync } from 'node:fs';
const url=process.env.DATABASE_URL;
if(!url) throw Error('Local DATABASE_URL missing');
const parsed=new URL(url);
if(!['postgres:','postgresql:'].includes(parsed.protocol) ||
   !['127.0.0.1','localhost','::1'].includes(parsed.hostname.toLowerCase()) ||
   decodeURIComponent(parsed.pathname.slice(1))!=='pulse_metrics' ||
   decodeURIComponent(parsed.username)!=='pulse_metrics_app' ||
   process.env.NODE_ENV==='production') {
  throw Error('Refusing production/remote/non-runtime database target');
}
const journal=JSON.parse(readFileSync('drizzle/meta/_journal.json','utf8'));
if(!Array.isArray(journal.entries) || journal.entries.length!==1 ||
   journal.entries[0]?.tag!=='0000_damp_tomorrow_man') {
  throw Error('Unexpected Drizzle migration journal; manual baseline review required');
}
const files=readdirSync('scripts/admin');
for(let n=1;n<=6;n++) {
  const prefix=String(n).padStart(3,'0')+'_';
  const matches=files.filter(f=>f.startsWith(prefix)&&f.endsWith('.sql'));
  if(matches.length!==1) throw Error(`Expected exactly one admin SQL bootstrap ${prefix}*.sql; found ${matches.length}`);
}
console.log('PASS: local runtime DB target, Drizzle journal and six administrator SQL sources');
NODE

# Independently validate the admin connection uses the intended local socket.
if [[ "$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -At -d pulse_metrics -c 'SELECT current_database() || chr(58) || current_user')" != 'pulse_metrics:postgres' ]]; then
  echo 'ERROR: local postgres audit connection is not pulse_metrics:postgres' >&2
  exit 1
fi

echo '========== MIGRATION SOURCE HASHES (NO SECRETS) =========='
sha256sum drizzle/0000_damp_tomorrow_man.sql \
  drizzle/meta/_journal.json scripts/admin/00[1-6]_*.sql

echo '========== LIVE DATABASE SECURITY BASELINE =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d pulse_metrics \
  < scripts/audit/migration-security-invariants.sql

echo '========== AUDIT COMPLETE =========='
echo 'PASS: local database baseline meets the tested invariants.'
echo 'NOTE: this is NOT a fresh-database replay or migration-parity certification.'
echo 'NOTE: no data, roles, schemas, grants, migrations or runtime config were changed.'
