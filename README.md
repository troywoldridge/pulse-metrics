# Pulse Metrics

Pulse Metrics is being developed as a commercial, multi-tenant infrastructure
monitoring platform. The intended product will let customers monitor computers
and servers through authenticated agents, with organization-scoped access to
live and historical telemetry.

**Development status: early foundation work. This repository is not
production-ready and must not be exposed as a public monitoring service.**

## Product direction

The planned architecture is:

- React and TypeScript customer dashboard.
- Node.js and Express API.
- PostgreSQL persistence with Drizzle ORM migrations.
- Organization-based customer and device ownership.
- Authenticated outbound monitoring agents.
- Transaction-scoped PostgreSQL Row-Level Security (RLS).
- Validated, versioned telemetry ingestion.
- Auditable customer and administrative actions.

The implementation will remain extensible for additional operating systems,
alerts, reports, integrations, and commercial plans without making those
features prerequisites for a reliable first release.

## Current repository status

The existing React dashboard and original Node.js service are a prototype.
Some displayed values and historical points are simulated, and the legacy
server still contains an unrestricted WebSocket command-execution path.
Authentication, organization provisioning, agent enrollment, secure
credential verification, tenant-aware telemetry ingestion, billing, and
production authorization are not yet complete.

Do not deploy this prototype to the public internet, accept customer data, or
use it to administer production systems. The legacy command-execution path
must be removed or replaced with narrowly authorized administrative actions
before any public deployment.

Development and test hosts are local infrastructure only. Their names,
addresses, credentials, SSH configuration, and hardware details are not part
of the commercial product configuration.

## Requirements

- Node.js 22 or later.
- npm.
- PostgreSQL for database migration and integration work.

## Run the existing UI prototype

Install dependencies:

```bash
npm install
```

Start the local development server:

```bash
npm run dev
```

The existing dashboard prototype is served at
[http://localhost:3000](http://localhost:3000).

This starts the prototype service; it does not mean database persistence,
customer authentication, tenant isolation, or agent ingestion are connected.

## Database foundation

The initial database schema is in `src/db/schema.ts`. The lazy PostgreSQL
client is in `src/db/client.ts`, and user-scoped tenant transactions are
provided by `src/db/tenant-context.ts`.

1. Copy `.env.example` to `.env`.
2. Configure `DATABASE_URL` for a dedicated local development database.
3. Install dependencies with `npm install` so `package-lock.json` is updated.
4. Generate a migration with `npm run db:generate`.
5. Review the generated SQL and snapshot files.
6. Apply it only to the intended development database with `npm run db:migrate`.

See [docs/database-foundation.md](docs/database-foundation.md) for the database
roles, Row-Level Security requirements, secret handling, and current scope.

Never commit `.env`, production credentials, enrollment tokens, agent
credentials, or private keys.

## Useful commands

```bash
npm run lint       # TypeScript check
npm test           # Unit tests
npm run build      # Production frontend build
npm run db:generate
npm run db:migrate
npm run db:check
```

## Security and release policy

A successful frontend build is not a security review. Before public customer
onboarding, the project must have verified authentication and authorization,
tenant-isolation tests using the actual restricted runtime database role,
secure agent enrollment and credential revocation, transport security,
telemetry validation, rate limiting, audit coverage, backup and recovery
procedures, and a documented data-retention policy.

Report security issues privately to the project maintainers rather than
publishing exploit details in public issues.

## License

Apache-2.0
