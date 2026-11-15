# Pulse Metrics — D15C-5S Isolated HTTPS sender-to-ingress rehearsal

**Status:** Candidate awaiting verification on `adap`. **PUBLIC LAUNCH: NO_GO**.

## Scope

D15C-4E's existing disposable PostgreSQL/HTTP integration already passed separately. D15C-5R's offline HTTPS sender tests also passed separately. This package adds the **next, narrower boundary test**: the actual D15C-5R sender uses Node's TLS-verifying fetch to POST genuine Linux collector telemetry to the existing D15C-2 ingress guard and D15C-4C HTTP handler over a test-only HTTPS listener.

This script uses **ephemeral test certificates, synthetic machine secrets and in-memory test receipts**. It does **not** connect to PostgreSQL; the existing PostgreSQL rehearsal must not be confused with a combined sender-to-real-database test.

## Test cases

- Real Linux collector output is sent over verified localhost HTTPS to the proposed path `/api/agent-telemetry/v1` (test-only; **not** an approved production route).
- TLS requires explicit disposable trust. Rejects an unrelated self-signed certificate and a wrong-host certificate signed by the trusted test CA.
- Isolated direct-TLS ingress guard runs before the JSON body parser. Requests are bound to `127.0.0.1` only.
- Existing isolated HTTP handler returns 202 for new and 200 for identical submissions. Same UUID with changed body yields 409.
- Synthetic credential rejection/revocation gives 401; a simulated agent quota denial gives 429 with bounded `Retry-After`.
- Fake agent identities have separate in-memory submission namespaces. **This is not a PostgreSQL tenant isolation test**.
- Browser/agent-supplied organization selector is rejected before network activity.
- No automatic retry, no real enrollment, no credential-vault access, no WorkOS access, no customer database changes, no production route mounts.

## Install

From `~/Projects/pulse-metrics`, inspect the ZIP before extraction. It must contain precisely these 3 new files:

- `README-D15C-5S.md`
- `scripts/telemetry-https/run-isolated-https-sender-rehearsal.sh`
- `scripts/telemetry-https/verify-sender-to-ingress.mjs`

Do not replace existing files. Then:

```bash
bash scripts/telemetry-https/run-isolated-https-sender-rehearsal.sh
npm run lint
npm test
npm run build
git diff --check
git status -sb
```

Requires Linux, Node with `--import tsx`, OpenSSL, Express and the existing Pulse Metrics codebase. The bash launcher rejects production `NODE_ENV`, disabled TLS verification, and preset `NODE_OPTIONS`. It generates a disposable CA and private key under an owner-only `/tmp/pulse-d15c5s-*` directory, uses `NODE_EXTRA_CA_CERTS` only in the child test process, and removes the directory on exit.

## Remaining step

Build a separate **combined actual HTTPS sender -> authenticated protected PostgreSQL gateway** test inside a marker-verified disposable PostgreSQL cluster. Review independently before wiring the Linux runner to a real agent identity or enabling any live ingress. Maintain **PUBLIC LAUNCH: NO_GO**.
