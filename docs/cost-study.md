# Cost study: 100,000 packages/day across 16 warehouses

Price check: **5 November 2026**. Region: **São Paulo (`sa-east-1`)**. Currency: **USD**. This estimates one shared regional deployment, without Lambda, for **100,000 packages/day in total**, not per warehouse. It is a planning model, not an AWS quote or a demonstrated production capacity.

The current production baseline is approximately **$538/month initially** and **$654/month in month 12**, before tax and exchange-rate effects. A 25% contingency gives **$673 and $818**, respectively. For budgeting, reserve **$700–850/month during the first year**, revisiting the amount after actual usage is measured. Retaining the ledger indefinitely raises storage and backup costs over time.

## Scope and scenarios

Thirty operating days produce 3 million receiving movements/month. The conservative model treats every package as a separately serialized movement. All services run for 730 hours/month. Sixteen warehouses share the API, database and queues; warehouse IDs do not require sixteen infrastructure stacks.

| Scenario               | Packages/day | API / worker / publisher tasks | NAT gateways |     Month 1 |    Month 12 | Month 1 / 12 with 25% margin |
| ---------------------- | -----------: | ------------------------------ | -----------: | ----------: | ----------: | ---------------------------: |
| Lean laboratory, no HA |      100,000 | 1 / 1 / 1                      |            1 |     $404.99 |     $520.94 |            $506.24 / $651.18 |
| Production baseline    |      100,000 | 2 / 2 / 1                      |            2 | **$538.49** | **$654.44** |        **$673.11 / $818.05** |
| Growth illustration    |      200,000 | 4 / 4 / 2                      |            2 |     $871.02 |   $1,102.93 |        $1,088.78 / $1,378.66 |

The laboratory profile requires a separate configuration: the production template intentionally requires at least two API and worker tasks. It is not a production recommendation. The baseline spreads API/worker capacity and networking across two availability zones, while its single publisher can briefly pause during a restart; the durable outbox preserves work. A second continuously running publisher adds approximately **$19.42/month** in compute and idle queries under this model. It removes that single-process availability gap, although complete availability still depends on the network, deployment and operational configuration.

API and worker tasks each allocate 0.5 vCPU/1 GB; the publisher allocates 0.25 vCPU/0.5 GB. The baseline therefore uses **2.25 vCPU and 4.5 GB**, Linux x86 Fargate on demand. Autoscaling beyond these average task counts adds cost. No Savings Plans, Spot discounts or free-tier credits are assumed.

## Baseline monthly breakdown

| Component                  |     Month 1 | Assumption                                            |
| -------------------------- | ----------: | ----------------------------------------------------- |
| Fargate                    |     $139.28 | Five tasks, 730 hours                                 |
| Application Load Balancer  |      $32.85 | One ALB, average one LCU                              |
| NAT gateway hours          |     $135.78 | Two gateways, one per AZ                              |
| NAT traffic                |       $9.30 | 100 GB processed                                      |
| Public IPv4                |      $14.60 | Minimum two ALB addresses plus two NAT addresses      |
| DynamoDB writes            |     $100.27 | 106.95 million WRUs                                   |
| DynamoDB reads             |      $24.00 | 127.974 million RRUs                                  |
| DynamoDB storage           |       $4.45 | 11.87 GiB monthly average, including indexes          |
| DynamoDB PITR              |       $2.36 | 7.87 GiB base-table monthly average                   |
| SQS                        |       $3.90 | Standard requests **and fair-queue surcharge**        |
| CloudWatch                 |      $48.70 | Logs, queries, Container Insights, metrics and alarms |
| ECR                        |       $0.50 | 5 GB retained images                                  |
| Internet data transfer out |      $22.50 | 150 GB at the first paid tier                         |
| **Total**                  | **$538.49** | Unrounded line values determine the total             |

At this modeled usage, the initial infrastructure cost is approximately **$0.18 per thousand packages**. This does not include warehouse labor, scanners, cameras, connectivity or development/support services.

## Public rates used

The checked-in [rate snapshot](cost-rates.json) records the AWS service and SKU for each value. Links below are the official regional AWS Price List files; `current` URLs can change after the check date.

| Service                     | São Paulo list price                                                                                               | Official source                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Fargate                     | $0.0696/vCPU-hour; $0.0076/GB-hour                                                                                 | [AmazonECS](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/sa-east-1/index.json)               |
| ALB                         | $0.034/hour; $0.011/LCU-hour                                                                                       | [AWSELB](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSELB/current/sa-east-1/index.json)                     |
| DynamoDB Standard on demand | $0.9375/million WRUs; $0.1875/million RRUs; $0.375/GB-month storage; $0.30/GB-month PITR                           | [AmazonDynamoDB](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonDynamoDB/current/sa-east-1/index.json)     |
| SQS                         | $0.40/million Standard requests + $0.10/million eligible fair requests                                             | [AWSQueueService](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSQueueService/current/sa-east-1/index.json)   |
| NAT                         | $0.093/gateway-hour; $0.093/GB processed                                                                           | [AmazonEC2 CSV](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/sa-east-1/index.csv)            |
| Public IPv4                 | $0.005/address-hour                                                                                                | [AmazonVPC](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/sa-east-1/index.json)               |
| CloudWatch                  | $0.90/GB log ingestion; $0.0408/GB-month storage; $0.009/GB queried; $0.30/metric-month; $0.135/alarm-metric-month | [AmazonCloudWatch](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudWatch/current/sa-east-1/index.json) |
| ECR                         | $0.10/GB-month                                                                                                     | [AmazonECR](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECR/current/sa-east-1/index.json)               |
| Internet egress             | $0.15/GB at the first paid tier                                                                                    | [AWSDataTransfer](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/sa-east-1/index.json)   |

Free allowances are account-wide and eligibility-dependent; excluding them keeps the model reproducible without knowing other account workloads. Taxes, currency conversion, paid AWS Support, DNS/domain registration, WAF, external identity providers, cross-region replication, manual backup/restore jobs and optional security services are outside this estimate. They must be added if selected.

## Derivation from this implementation

### Database requests

Assume each ledger item, including actor attribution and history keys, fits within **2 KiB**, and each product, warehouse, idempotency, outbox, balance and unit item fits within **1 KiB**. These are planning bounds, not measured production records; long identifiers or metadata can cross a billing boundary. Transactions use two write units per 1 KiB; GSIs add ordinary index writes. Updating an indexed key deletes the old index entry and inserts the new one. [DynamoDB billing](https://aws.amazon.com/dynamodb/pricing/), [GSI write and query accounting](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html).

The two product/warehouse eligibility `ConditionCheck` actions are part of `TransactWriteItems`. They consume **two WRUs each** at the assumed size, rather than transactional read units. AWS explicitly includes `ConditionCheck` in its write-capacity accounting for this API. A condition attached to a Put/Update is already included in that action; the two separate eligibility actions here are additional. [AWS read/write capacity guide](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html).

| Successful serialized movement                 | Base-table WRUs |                   Index WRUs |
| ---------------------------------------------- | --------------: | ---------------------------: |
| Accept: ledger, idempotency, outbox            |               8 |         3: history 2 + due 1 |
| Accept: product and warehouse condition checks |               4 |                            0 |
| Apply: ledger status, balance, unique unit     |               8 |       3: history 2 + stock 1 |
| Claim outbox lease                             |               1 | 2: due-key delete and insert |
| Mark published                                 |               1 |    1: remove due-index entry |
| **Total**                                      |          **22** |                        **9** |

Thus `3,000,000 × 31 × 1.15 = 106,950,000 WRUs`. The 15% allowance covers retries, conflicts, small catalog/user changes and miscellaneous operations. It is an assumption, not a measured retry rate; heavy contention could exceed it. Failed transactions can still consume capacity. [AWS transaction behavior](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html).

The browser workload budgets **31 RRUs per movement**: code lookup 4; authenticated acceptance and pre-reads 5; worker read 1; two authenticated status reads 6; two authenticated history refreshes 14; useful publisher queries 1. Each authenticated business request reads the session and current user. A history page of twenty 2-KiB rows costs `ceil(40 KiB / 4 KiB) × 0.5 = 5 RRUs`, plus 2 for authentication. Query rounding applies to combined bytes, not separately to each row.

Add 15% for extra reads and the conservative idle-publisher bound: `16 shards × 0.5 RRU × 730 × 3,600 = 21.024 million RRUs/month/publisher`. This counts a whole month of idle queries in addition to useful queries, intentionally leaving headroom during active periods. **The sixteen outbox shards are unrelated to the number of warehouses.** Total: `3m × 31 × 1.15 + 21.024m = 127.974m RRUs`. Frequent stock browsing, long processing delays or repeated polling can increase this.

### Queue and observability

Each small queue message incurs one send, an average one fifth of a batched receive, and one delete: **2.2 requests/movement**, plus 15%. Empty long polling is additionally budgeted at one request/worker/20 seconds. The project sends `MessageGroupId` to a Standard queue; eligible send/receive/delete/visibility requests therefore incur **both** Standard and fair-queue charges. Payloads in this project remain below the 64-KB billing chunk. [SQS pricing rules](https://aws.amazon.com/sqs/pricing/).

CloudWatch assumes 20 GB ingested, 20 GB stored and 20 GB queried each month, plus a budget of 90 metric-months and 20 standard alarm-metric-months. Classic Container Insights contributes one cluster ×13 + three services ×14 paid metrics + three task-definition names ×10 =85 paid metrics; `RunningTaskCount` is free. Two application log metrics bring the expected count to 87, rounded up to 90 for this budget. The alarm allowance includes the five explicit alarms and generated target-tracking alarms. Actual cardinality, extra dimensions, retention and enhanced Container Insights would change this. [CloudWatch pricing examples](https://aws.amazon.com/cloudwatch/pricing/).

### Networking and retained history

**The 100-GB NAT assumption requires free DynamoDB and S3 gateway endpoints in the existing VPC.** The application template accepts an existing network; it does not create these endpoints or NAT gateways. Without them, repeated database responses alone can send hundreds of GB through NAT. Two history refreshes at the modeled size can return roughly 240 GB/month before other database operations. Add NAT processing and any cross-AZ charges accordingly. Route each subnet through its same-AZ gateway. [VPC pricing](https://aws.amazon.com/vpc/pricing/).

Two NAT gateways cost $135.78/month even when idle. Interface endpoints are an alternative to evaluate, not automatically a saving: four endpoint services across two AZs at $0.021/AZ-hour already cost $122.64/month plus data processing; some deployments need additional endpoints or external connectivity. Public ALB response traffic is included in internet egress, rather than charged again as NAT traffic. ALB capacity, IPv4 address count and transfer volumes must be measured.

The ledger, idempotency and unique-unit records have no expiry. Consistently using the item-size bounds above gives **4 KiB of permanent base-table payload** (2 + 1 + 1) and **6 KiB including the history index** (another 2). Add the documented 100-byte storage overhead per record/index entry: **4,396 bytes base / 6,544 bytes total per movement**. These payload bounds include attribute names, values and keys. Feature-specific internal overhead may add more, so validate actual billed storage. [AWS item storage accounting](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/CapacityUnitCalculations.html).

Add a seven-day published outbox at 1,124 bytes/item and 2 GiB of catalog/balance/identity/index overhead, of which 1 GiB is in the base table. The full seven-day outbox is a conservative steady-state bound even in the first month. For month `m`, average permanent movement count is `3,000,000 × (m − 0.5)`.

At startup there is little historical data. Month 1 averages **11.87 GiB total / 7.87 GiB base**; month 12 averages **213.00 GiB total / 142.98 GiB base**. Their storage + PITR costs are **$6.82 versus $122.77/month**. Twelve modeled 30-day months retain 36 million movements; a full 365-day year retains 36.5 million, roughly 222 GiB of permanent data at this size, before other records. PITR is charged on base-table and local-index size, excluding global indexes. A shorter PITR window does not lower its per-GB charge. [DynamoDB backup pricing](https://aws.amazon.com/dynamodb/pricing/).

### Bulk units and peaks

If a package/receipt represents ten interchangeable units, 100,000 physical units/day could require only 10,000 bulk movements. Requests and retained history then shrink, and the unique-unit write disappears. Compute, ALB and NAT hourly costs remain: **do not divide the entire bill by ten**. Serialized items still require their own unique identity; a shared product barcode is not a serial number.

For 100,000 movements over eight operating hours, average load is **3.47 movements/second** across all warehouses. A hypothetical 30× burst is approximately **104/second**. These figures describe demand, not proven capacity. Benchmark the complete cloud path, including authentication, history refreshes, skew toward a popular SKU/warehouse, queue lag and autoscaling. The previous local benchmark is not evidence of this production workload's throughput. The growth scenario doubles average task allocation as a cost illustration, not a guarantee of performance.

## Reproduce and improve the estimate

```sh
node scripts/estimate-cost.ts
node scripts/estimate-cost.ts --scenario ha --month 12
node scripts/estimate-cost.ts --scenario growth --packages-per-day 250000
```

The estimator reads the checked-in rate snapshot and makes no AWS calls. Changing volume scales traffic assumptions, not task counts. Refresh regional rates before committing a budget; then replace item-size assumptions with measured DynamoDB consumed capacity and bytes, and replace traffic/log figures with a representative pilot week.

The highest-value next improvements are a cloud load test with the real user flow; deployment of the gateway endpoints; tuning publisher idle polling and browser history refreshes; a deliberate history/archive policy that preserves duplicate protection and audit requirements; and budget alerts with service cost allocation. Consider ARM64 or commitment discounts only after compatibility, usage stability and pricing are verified.
