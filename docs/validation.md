# Validation evidence

## Web console 1.1 validation — 2026-11-05

- 65 unit/API/security/reconciliation tests passed.
- 27 DynamoDB/SQS integration tests passed, including catalog ownership, barcode races, migration, hashed passwords, session expiry/revocation and distributed login limits.
- 6 Chromium browser scenarios passed: product creator attribution and hardware-style scanning; mobile permissions; camera fallback decoding a real EAN-13 image from a synthetic video stream and stopping capture; uncertain-response replay without duplicate stock; password change and re-login; all eight printable demo labels decoded to their expected catalog values.
- Desktop and 390 px mobile layouts were inspected with no page errors or document overflow in the tested flows.
- 16 demo warehouses, 8 products and 48 stable movements were seeded; all 48 became APPLIED and the fixture subset totaled 16 units per warehouse, 256 overall. Re-running the seed returned 48 APPLIED replays and preserved stock. Both demo accounts signed in successfully; the manager saw 16 warehouses and the operator saw 2, with other warehouse requests denied.

Physical USB/Bluetooth devices and a real phone camera were not available in this environment. Browser decoding used actual EAN-13 pixels and the real local ZXing decoder; it does not certify warehouse hardware or lighting conditions. The earlier backend load study below remains a separate baseline, not a fresh browser throughput test.

## Backend 1.0 reference validation

Validation performed on 2026-11-05. Application checks run with Node.js 24.19.0; integration uses LocalStack 4.12.0. These are local engineering results, not a deployed AWS certification.

| Check                                                           | Recorded outcome                          |
| --------------------------------------------------------------- | ----------------------------------------- |
| Strict TypeScript, formatting and generated schema              | Passed                                    |
| Domain, planning, API, JWT, processing and reconciliation tests | 54 passed                                 |
| DynamoDB/SQS integration                                        | 11 passed                                 |
| Dependency audit                                                | Zero known vulnerabilities reported       |
| CloudFormation validation                                       | cfn-lint 1.58.0 passed for both templates |
| Docker image and Compose services                               | Built; API readiness succeeded            |
| Architecture diagram                                            | Mermaid parser accepted the flowchart     |

The integration suite exercised concurrent acceptance/application, conflicting HTTP/business identities, cross-warehouse serial uniqueness, product and warehouse deactivation, organization isolation, scoped pagination, publisher lease recovery, repeated SQS delivery, authenticated HTTP-to-stock processing, lost transaction acknowledgement after commit, and poison-message redrive to the DLQ.

Unit tests additionally exercise production RS256/JWKS verification, algorithm substitution, forged/expired tokens, warehouse authorization, visibility heartbeats, failed heartbeat acknowledgement behavior, and reconciliation bounds/mismatches.

## Recorded local load

The [machine-readable result](local-load-result.json) records a completed run through the HTTP API and all three container services:

| Measurement                          | Observed result                                                  |
| ------------------------------------ | ---------------------------------------------------------------- |
| Unique movements                     | 2,000                                                            |
| Physical units                       | 101,000: 1,000 serialized units plus 1,000 bulk movements of 100 |
| Additional HTTP replays              | 200, with stable entry identities                                |
| Client concurrency                   | 10                                                               |
| Acceptance duration                  | 57.94 seconds                                                    |
| Acceptance throughput                | 34.52 unique movements/second, including replay overhead         |
| Acceptance p95 / p99                 | 394.93 ms /483.63 ms                                             |
| Completion and verification duration | 164.06 seconds from run start                                    |
| Final states                         | All 2,000 APPLIED                                                |
| WH-01 stock                          | 80,800 expected and observed                                     |
| WH-02 stock                          | 20,200 expected and observed                                     |

Read-only reconciliation then compared 1,600 applied movements in WH-01 and 400 in WH-02 against their stock balances: no pending records and zero mismatches. One API, one publisher and one worker container ran against the local emulator. This is a 2,000-movement test representing 101,000 physical units, not a 100,000-individual-movement benchmark or a production daily-capacity guarantee.

## Reproduce

```powershell
npm ci
npm run check
docker compose up -d --build
npm run test:integration
npm audit --audit-level=moderate
cfn-lint infra/service.json infra/registry.json
```

The end-to-end load runner requires `.env` copied from `.env.example` and the local Compose stack. It uses real HTTP requests, the container publisher and worker, and the emulator's DynamoDB transactions and SQS queues. Results are only attributed to a run after all movements finish and stock matches.

```powershell
npm run test:load -- --count 2000 --concurrency 10 --output docs/local-load-result.json
npm run reconcile -- --organization DEMO --warehouse WH-01 --quiescent
npm run reconcile -- --organization DEMO --warehouse WH-02 --quiescent
```

## Interpretation

Local emulation does not reproduce AWS IAM enforcement, networking, partition throughput, failover or fair-queue scheduling. Infrastructure lint validates the template structure and supported resource properties; it does not deploy it. AWS-specific load profiles, task failure/recovery, cost measurements and restore exercises are described in [capacity planning](capacity.md) and [deployment](deployment.md).

An initial load attempt was interrupted by Docker Desktop becoming unavailable. That attempt produced no valid benchmark. The environment was restarted and the full integration suite passed again before the recorded load run.
