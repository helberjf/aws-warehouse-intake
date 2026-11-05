# Architecture decisions

Status: implemented receiving backend with API, outbox publisher, inventory worker and CloudFormation infrastructure. Local tests exercise the workflow; deployment-specific performance must be measured separately.

## 1. Containers for the API, publisher and workers

Use TypeScript services on ECS/Fargate. The HTTPS API accepts receiving movements; publisher tasks drain a durable outbox; worker tasks long-poll SQS and update inventory. Each service can scale independently. Workers have no public ingress. Separate execution roles from application task roles and scope each task to its own tables, indexes, queues and log groups.

ALB handles HTTPS ingress. Identity validation and warehouse authorization are API responsibilities; use provisioned password accounts with opaque browser sessions, or configure a trusted JWT issuer/audience/JWKS for machine access as described in [authentication](browser.md). Do not trust warehouse membership, organization ID or product tracking mode from request body fields. Store neither scanner credentials nor AWS access keys in the repository.

Production task placement should span availability zones. Lab and production task counts are separate decisions. Private-task egress must be designed explicitly using suitable endpoints or controlled NAT; neither has an assumed zero cost. Container images belong in ECR and log retention must be bounded.

## 2. Durable acceptance before queue publication

The API transactionally stores a receiving entry, its idempotency response and an outbox intent before returning `202`. It must not rely on an independent database write followed by a best-effort `SendMessage`.

A publisher queries a sparse, sharded pending-work index and conditionally leases each intent, checking its due time in the same write. It sends SQS before conditionally marking the intent published. A crash between those steps can send the message twice; a pending intent remains recoverable. Remove pending-index attributes after publication. Expire only published transport records, never unpublished work or live stock records.

Choose the shard count from measured load; changing it requires draining or querying both old and new shard versions. Empty polling and index writes have costs. Avoid a global table scan or an unbounded read of every warehouse.

This applies the [transactional outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) with a container publisher. The business write and durable publication intent are atomic; delivery acknowledgment is a separate boundary.

## 3. Idempotent inventory application

SQS delivery is at least once. A worker must atomically transition a ledger entry from `ACCEPTED` to `APPLIED`, add the received quantity to the relevant warehouse/SKU/lot balance, and conditionally register a serialized unit when applicable. Use the ledger condition to prevent a duplicate from incrementing the balance again. Use atomic addition rather than reading a balance and replacing it with a computed total.

After ambiguous transaction errors, read the ledger consistently before deciding whether to retry. Delete the SQS message only after a committed result has been confirmed. A permanently invalid business operation should become an explicit `REJECTED` ledger entry with no stock change; transient storage errors should retry. A different entry trying to receive an already registered serial number must be rejected without revealing another warehouse's private data.

The domain helpers generate identities and hashes; the DynamoDB adapter implements the persistence conditions. [DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html) provide the atomic write boundary. Normal read views and GSIs must account for asynchronous propagation.

## 4. Warehouse fairness without global ordering

Initial intake increments commute, so use an SQS Standard queue. Set `MessageGroupId` to the stable hash of organization and warehouse, already produced by the domain helper. On Standard queues this enables [SQS fair-queue behavior](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-fair-queues.html); it does not turn the queue into FIFO or guarantee ordering.

Fairness helps one warehouse's surge avoid dominating other warehouses, but it is not a per-warehouse throughput quota or a strict latency guarantee. Measure each warehouse's wait time. Dedicated queues are an option when an operation requires stronger isolation; FIFO becomes relevant only if future business transitions require ordering.

Workers should use long polling, bounded concurrency and visibility extensions for legitimate long-running work. On shutdown, stop receiving new messages and drain active work; leave unfinished messages for redelivery. Set a measured visibility timeout, finite redrive attempts and a DLQ alarm, then test worker termination and redrive. [SQS polling behavior](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-short-and-long-polling.html).

## 5. Scale by the limiting stage

Scale API tasks by request/latency and CPU signals. Scale workers using backlog per running task and processing duration, with message age as an operational signal. ECS supports [queue-based service scaling](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-autoscaling-queue.html); its documented task-count metric depends on Container Insights. Budget for that telemetry and handle the zero-task case explicitly instead of dividing by zero.

Publisher backlog needs its own observation: healthy SQS depth does not prove all accepted outbox events were sent. More workers cannot fix a hot inventory key or an upstream publisher bottleneck. Validate contention on the busiest SKU, warehouse and lot before increasing concurrency.

## 6. Receiving is an auditable movement

The first operational scope is incoming stock, not a complete warehouse-management system. Transfers, outbound stock, returns, reversals, physical bin allocation and cycle counts need their own explicit movement types and rules. Never correct stock by deleting a receiving entry. Use a future compensating movement with an audit trail.
