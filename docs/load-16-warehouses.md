# Load testing across 16 warehouses

Measured on **5 November 2026**, against application commit `6936813942c01accdb61da9d87e1b2f3eeceb679` using the existing local Docker stack. This is local engineering evidence, not an AWS production capacity certification.

**Conclusion:** the five-minute browser workload passed at four individual packages/second across sixteen warehouses. The separate 100,000-package saturation attempt was stopped at the user's request before completion. It revealed substantial processing lag; it does **not** validate the complete daily target, an eight-hour endurance run or AWS production capacity.

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

## Saturation attempt, stopped by the user

The second run targeted 100,000 individually serialized receipts across sixteen warehouses with 32 concurrent authenticated submissions, no arrival-rate cap, and 1% exact replay probes. It used one SKU and an even warehouse distribution. The application, services and container counts were unchanged throughout the run.

The user requested ending the test before the target completed. Load generation was stopped; the existing publisher and worker were left running to process already accepted work. The Windows command interruption retained the latest periodic checkpoint rather than the runner's normal final report. The original checkpoint remains unchanged, accompanied by a separate stop record and a subsequent read-only database observation.

| Measurement                                                    |        Recorded result |
| -------------------------------------------------------------- | ---------------------: |
| Last checkpoint elapsed time                                   | 2,356.01 s / 39.27 min |
| HTTP-confirmed entries at that checkpoint                      |                 66,164 |
| Submission throughput at checkpoint                            |               28.096/s |
| Exact replay probes confirmed                                  |                    662 |
| Failed submissions / HTTP retries at checkpoint                |                  0 / 0 |
| Persisted receiving records found after stopping               |                 66,350 |
| Identity, serial, operator, quantity or stock-bound mismatches |                      0 |
| Missing indices within the persisted reference range           |                      0 |
| APPLIED records observed during the history read               |                  9,538 |
| ACCEPTED records observed during the history read              |                 56,812 |
| REJECTED records observed during the history read              |                      0 |
| Stock units observed after the warehouse history reads         |                  9,550 |
| Full 100,000 target / final reconciliation                     |          Not completed |

The post-stop observation ran from **06:16:22 to 06:17:21 UTC** (03:16:22–03:17:21 in São Paulo). Workers continued running, so history statuses and subsequent consistent stock reads are **not one atomic snapshot**. Their difference reflects ongoing processing, and these counts are not a final stock balance. The extra 186 persisted records relative to the checkpoint are consistent with work accepted after that checkpoint and requests already in flight; they are not evidence of duplicate stock increments. All observed references were unique and contiguous from index 0 through 66,349.

The receiving rate must not be confused with completion throughput. Just before the stop, a progress observation showed only 7,280 stock units against a checkpoint of 65,123 HTTP confirmations. Most unfinished work was upstream of SQS, in the durable outbox. Across 75 resource samples, the main queue peaked at nine visible and nine in-flight messages; the dead-letter queue stayed at zero in the samples. A small SQS queue therefore did not imply that processing had caught up.

| Container  | Sampled peak CPU | Sampled peak memory |
| ---------- | ---------------: | ------------------: |
| API        |           40.20% |           227.2 MiB |
| Publisher  |            4.54% |           193.3 MiB |
| Worker     |            7.05% |           174.6 MiB |
| LocalStack |          189.39% |           982.4 MiB |

CPU 100% represents one logical core, not all sixteen cores. Samples were roughly 32 seconds apart and can miss shorter peaks. Low publisher CPU, a nearly empty queue and a growing outbox are consistent with latency in its sequential lease-claim path under emulator contention. This is a bottleneck hypothesis supported by the code and observations, not an isolated causal benchmark or proof that real DynamoDB behaves similarly.

The planned hot-warehouse burst was not run after the stop request. The next useful measurements are the same authenticated workload in an isolated AWS deployment with the intended Fargate limits, followed by a controlled comparison of publisher concurrency and scaling. No production throughput guarantee or final processing latency percentile is derived from this interrupted attempt.

Evidence: [original checkpoint](load-results/receiving-100000-checkpoint.json), [stop record](load-results/receiving-100000-stop.json), [post-stop observation](load-results/receiving-100000-observed.json), [sampled resources](load-results/receiving-100000-resources.json), and [progress observations](load-results/receiving-100000-observations.json).

## Environment and reproducibility

- Windows host: AMD Ryzen 7 Pro 7735U, sixteen logical CPUs, approximately 16 GB RAM.
- Docker: sixteen available logical CPUs and 7.38 GiB RAM shared by the containers.
- One API, one publisher, one worker and LocalStack 4.12.0, with no per-application CPU/memory caps.
- Node.js 24.19.0. The load driver and emulator share the host. This differs from the two-API/two-worker Fargate cost-study baseline and its task limits.
- Unique synthetic organization per run; the user's `DEMO` catalog and balances remain separate. A single serialized SKU per run deliberately concentrates inventory writes within each warehouse.
- No application service was scaled or restarted during the measured workload. No AWS resources were created.

[Raw browser result](load-results/browser-1200.json), [independent audit](load-results/browser-1200-audit.json), and [environment snapshot](load-results/environment.json) preserve the evidence. See [capacity planning](capacity.md#executable-load-and-reconciliation) for executable commands and the distinction between closed-loop saturation and scheduled arrivals.

Acceptance throughput measures durable recording, not completed inventory. During overload, work can accumulate in the DynamoDB outbox while SQS remains almost empty. A capacity conclusion must include completed movements, drain time and exact reconciliation, not merely HTTP `202` responses or queue size.
