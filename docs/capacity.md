# Capacity planning for more than 100,000 units/day

Daily volume alone is insufficient to size a receiving system. The relevant inputs are physical units, movements, peak arrival rate, operating hours, warehouse distribution, SKU concentration, processing time and acceptable queue delay.

## Reproducible planning scenarios

The examples below assume 100,000 physical units/day, an eight-hour operating window, bulk movements of 100 units and a hypothetical 30-times peak multiplier. They are arithmetic scenarios, not measured AWS performance.

| Scenario                             | Movements/day | Average during 8 hours | Hypothetical peak |
| ------------------------------------ | ------------: | ---------------------: | ----------------: |
| All units serialized                 |       100,000 |                 3.47/s |          104.17/s |
| 50% serialized units, 50% bulk units |        50,500 |                 1.75/s |           52.60/s |
| All bulk, 100 units per movement     |         1,000 |                0.035/s |            1.04/s |

```bash
npm run capacity -- --daily-units 100000 --serialized-share 1 --active-hours 8 --peak-factor 30 --warehouses 5
npm run capacity -- --daily-units 100000 --serialized-share 0.5 --avg-bulk-units 100 --active-hours 8 --peak-factor 30 --warehouses 5
npm run capacity -- --daily-units 250000 --serialized-share 0.5 --avg-bulk-units 100 --active-hours 8 --peak-factor 30 --warehouses 10
```

The warehouse count in these examples is illustrative. The calculator's even-distribution figure is a reporting aid, not a promise that warehouses receive equal traffic. A single busy warehouse or popular SKU can dominate the load. Bulk counts round up a final partial movement; real delivery boundaries can create more movements. Retries, notifications, outbox writes and DynamoDB transaction/index overhead add work beyond these business movement counts.

## Proposed load-test profiles

Use synthetic test data and an explicitly approved isolated environment. Initial benchmark targets to evaluate are:

1. A complete 100,000-movement run with zero lost accepted entries and zero duplicate stock increments.
2. Sustained 100 movements/second for 15 minutes, measuring acceptance and completion latency separately.
3. A 500-movements/second burst for 30 seconds, followed by measured backlog drain.
4. Duplicate deliveries, repeated HTTP keys, conflicting business references and duplicate serial numbers.
5. Eighty percent of traffic in one warehouse, plus a hot-SKU scenario; observe the other warehouses' delays.
6. Kill worker and publisher tasks at commit/acknowledgment boundaries, then verify ledger and stock convergence.

These are proposed test profiles, not validated service limits or promised SLOs. Use the measurements to establish p95/p99 latency targets, task sizes, concurrency caps, outbox shards, retry policies and acceptable recovery time.

For backlog recovery, a sustained processing capacity `mu` must exceed the arrival rate `lambda`. An approximate drain time is `backlog / (mu - lambda)` while rates remain stable. Scaling workers cannot repair an inventory-key bottleneck, a stalled publisher or a service quota limit.

## Cost model

The architecture has a running-cost floor: API, publisher and worker tasks consume CPU/memory while running, and the load balancer, network, observability and data storage are additional cost drivers. SQS Standard/fair-queue requests, DynamoDB transactions/indexes and empty polling must be included. Choose region and availability requirements before estimating a monthly budget; no numeric AWS cost is assumed here. [Fargate pricing](https://aws.amazon.com/fargate/pricing/), [SQS pricing](https://aws.amazon.com/sqs/pricing/), [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/), [load-balancer pricing](https://aws.amazon.com/elasticloadbalancing/pricing/).

Task count should come from measured processing duration and per-task concurrency under realistic contention. Production resilience and a low-cost lab have different minimum counts. Creating this repository provisions no AWS resources and proves no production throughput.

## Executable load and reconciliation

Start the local Compose stack, copy `.env.example` to `.env`, then run `npm run test:load -- --count 1000 --concurrency 10`. The runner uses a unique synthetic run identity, 50% serialized and 50% bulk movements of 100units, two warehouses with 80/20 distribution, and 10% extra HTTP replays. It waits for every movement and checks exact balances. These are closed-loop concurrent requests, not a constant-rate arrival generator; reported acceptance throughput includes replay overhead.

For an isolated AWS benchmark, provide `LOAD_TEST_TOKEN` for the DEMO catalog, set `.env` appropriately, and explicitly use `--url https://your-test-host --allow-remote`. The runner never creates resources and rejects a remote target without that explicit flag. The count option supports 100,000 and larger runs. Run only with synthetic data and no concurrent unrelated serialized receipts, since stock reconciliation compares before/after totals.

Recorded local evidence is kept in [validation](validation.md). The longer proposed profiles above remain deployment qualification targets.
