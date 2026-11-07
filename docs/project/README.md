# Pulse Metrics — Project Documentation

This directory is the authoritative planning and progress record for Pulse Metrics.

## Documents

| Document | Purpose |
|---|---|
| [PROJECT-VISION.md](PROJECT-VISION.md) | Product purpose, customers, principles and commercial direction |
| [MASTER-ROADMAP.md](MASTER-ROADMAP.md) | Development phases, dependencies and completion criteria |
| [CURRENT-STATUS.md](CURRENT-STATUS.md) | Current position, verified progress and next tasks |
| [ARCHITECTURE-DECISIONS.md](ARCHITECTURE-DECISIONS.md) | Important technical decisions and their rationale |
| [SECURITY-CHECKLIST.md](SECURITY-CHECKLIST.md) | Security requirements and verification status |
| [TESTING-PLAN.md](TESTING-PLAN.md) | Test strategy, evidence and outstanding coverage |
| [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) | Requirements for production and public launch |

The database foundation is documented separately in
[`../database-foundation.md`](../database-foundation.md).

## Documentation maintenance rules

1. Update CURRENT-STATUS.md whenever a meaningful milestone is completed.
2. Update MASTER-ROADMAP.md when scope, phase order or completion criteria change.
3. Record significant technical decisions in ARCHITECTURE-DECISIONS.md.
4. Never mark a security or release requirement complete without evidence.
5. Distinguish implemented, tested, verified and production-ready.
6. Record failed tests and known limitations rather than hiding them.
7. Keep credentials, passwords, tokens, private keys and customer secrets out
   of documentation and Git.
8. Update these documents as part of the work, not months after it.

## Status terminology

- **Not started:** Work has not begun.
- **Planned:** Scope is understood but implementation has not begun.
- **In progress:** Implementation or investigation is underway.
- **Implemented:** Code or configuration exists.
- **Tested:** A relevant test has been run successfully.
- **Verified:** Evidence supports the stated behavior in the intended environment.
- **Blocked:** Work cannot proceed until a dependency or issue is resolved.
- **Complete:** All documented completion criteria have been satisfied.

A successful local test does not automatically mean production-ready.
