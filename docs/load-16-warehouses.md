# Load testing across 16 warehouses

Measured on **5 November 2026**, against application commit `6936813942c01accdb61da9d87e1b2f3eeceb679` using the existing local Docker stack. This is local engineering evidence, not an AWS production capacity certification.

## Completed browser workload

The runner offered 1,200 individually serialized package receipts at four arrivals/second for five minutes. Each receipt used a real password/session identity and CSRF protection, barcode lookup, an authenticated receiving request, two twenty-row history refreshes, up to two status requests and a stock query. It also sent twelve exact HTTP replay probes. A synthetic 250-ms polling gap differs from the real browser's two-second interval; this is an HTTP workload, not camera or DOM automation.

| Measurement                                                   |                     Result |
| ------------------------------------------------------------- | -------------------------: |
| Unique packages accepted and verified APPLIED                 |                      1,200 |
| Warehouses / final units in each                              |                    16 / 75 |
| Offered arrival rate                                          |                     4.00/s |
| Observed submission throughput, including workflow completion |                    3.996/s |
| Submission duration                                           |                   300.29 s |
| Last stored processing completion, from first launch          |                   300.84 s |
| Acceptance latency p50 / p95 / p99                            | 68.67 / 129.54 / 187.52 ms |
| Stored acceptance-to-completion latency p50 / p95 / p99       |     487 / 1,414 / 1,558 ms |
| Failed requests / HTTP retries / dropped arrivals             |                  0 / 0 / 0 |
| Rejected receipts / stock mismatches                          |                      0 / 0 |
| Independently checked outbox and unit records                 |        2,400 / 2,400 valid |
| Final queue / dead-letter queue / pending outbox              |                      Empty |

The final stock and history verification finished after 317.37 seconds. Most of the difference from processing completion is the runner's fifteen-second drain-observation interval; it is not processing latency. All sixteen balances were read consistently and every accepted ID, serial, reference, operator and terminal status was verified. A separate strongly consistent batch-read audit verified publication and serial ownership.

This short workload exceeded the average **3.472 receipts/second** needed for 100,000 individual packages in eight hours, with no accumulating backlog at the end. It does not establish an eight-hour endurance result, peak capacity or cloud performance.

## Environment and reproducibility

- Windows host: AMD Ryzen 7 Pro 7735U, sixteen logical CPUs, approximately 16 GB RAM.
- Docker: sixteen available logical CPUs and 7.38 GiB RAM shared by the containers.
- One API, one publisher, one worker and LocalStack 4.12.0, with no per-application CPU/memory caps.
- Node.js 24.19.0. The load driver and emulator share the host. This differs from the two-API/two-worker Fargate cost-study baseline and its task limits.
- Unique synthetic organization per run; the user's `DEMO` catalog and balances remain separate. A single serialized SKU per run deliberately concentrates inventory writes within each warehouse.
- No application service was scaled or restarted during the measured workload. No AWS resources were created.

[Raw browser result](load-results/browser-1200.json), [independent audit](load-results/browser-1200-audit.json), and [environment snapshot](load-results/environment.json) preserve the evidence. See [capacity planning](capacity.md#executable-load-and-reconciliation) for executable commands and the distinction between closed-loop saturation and scheduled arrivals.

Acceptance throughput measures durable recording, not completed inventory. During overload, work can accumulate in the DynamoDB outbox while SQS remains almost empty. A capacity conclusion must include completed movements, drain time and exact reconciliation, not merely HTTP `202` responses or queue size.
