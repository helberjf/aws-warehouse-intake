# Operations

## Processing and monitoring

ACCEPTED means durably recorded, APPLIED means one stock effect, and REJECTED means none. Status reads are consistent; history uses an eventually consistent index. Worker log counter `applied` counts acknowledged terminal messages, including replays and rejections; business totals come from ledger states.

Structured logs and alarms cover API, publisher and worker errors, queue age and DLQ depth. Attach an SNS topic to route alerts. Empty SQS depth does not prove a healthy publisher. Due-index partitions are OUTBOX#v1#00 through OUTBOX#v1#15.

## Recovery

1. Identify the failing acceptance, publication or application stage. Read ledger status consistently.
2. Correct the fault. Publisher leases expire after 60 seconds and unfinished work is reclaimed automatically.
3. Inspect DLQ references. Messages require version 1 and a valid existing entry ID. Missing ledger data is an integrity incident; do not fabricate it.
4. Perform a controlled SQS redrive below measured worker capacity after correcting the cause. Five receives lead to dead lettering; main retention is four days and DLQ retention fourteen days.
5. Reconcile outcomes. After a prolonged outage, expired queue messages may require an audited operator to republish the original entry reference for still-accepted entries. Keep the business identity unchanged.

Operational inspection/redrive permissions belong to an operator role. Do not purge queues or delete ledger identities to repair retries. Duplicate serial rejection does not automatically create an adjustment.

## Reconciliation and restore

Quiesce warehouse writes and drain accepted work before reconciliation. History indexes can lag; repeat after propagation settles. Compare APPLIED quantities grouped by SKU/lot to balances. Use controlled exports or reporting projections for large estates, not request-time scans.

Point-in-time restoration creates a new table. Restore ledger, replay records, stock, serial registry and outbox together. Pause ingestion/workers, select a recovery point, reconcile queued deliveries against restored data, then switch service configuration. Recover later accepted movements from upstream producers using their original references. Exercise recovery with synthetic data before establishing a recovery objective.

Published outbox records expire after seven days. Unpublished records, HTTP replay identities, ledger, serial registrations and stock have no automatic expiry. Include permanent deduplication storage in capacity estimates. Retention changes require a deliberate migration.

## Releases

Build one immutable image, review its scan and update all three roles. Preserve the previous digest for rollback. Queue/schema changes must tolerate older in-flight messages during rolling updates. Changing the 16 version 1 outbox shards requires draining/querying both versions.

SIGTERM stops new polling and drains active work. ECS permits 120 seconds and the process has a 110 second deadline. Unfinished work recovers through queue visibility or outbox lease expiry.

Production retains data, queues, logs and images on stack removal. Export records, satisfy retention policy and retire producers before deliberately disabling deletion protection or deleting retained resources.

## Read-only reconciliation command

With `.env` configured, run `npm run reconcile -- --organization DEMO --warehouse WH-01 --quiescent`. This requires an operator with scoped read access and a quiet, drained warehouse. It compares APPLIED movement totals with queried SKU/lot balances, reports pending/rejected entries and mismatches, and exits nonzero for mismatch or incomplete coverage. Default maximum 100,000 entries can be adjusted using `--max-entries`. It performs bounded index queries, not table scans, and cannot discover orphan stock for SKUs entirely absent from the ledger. GSI propagation means success is an observation, not a database snapshot or full forensic audit.
