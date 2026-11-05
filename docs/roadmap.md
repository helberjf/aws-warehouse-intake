# Next improvements

The receiving backend includes authenticated API access, atomic acceptance, a durable outbox publisher, idempotent workers, queries, integration tests and ECS/Fargate infrastructure.

1. **Measure deployment capacity and cost.** Run 100,000-movement, sustained, burst and hot-SKU profiles in an isolated AWS environment. Tune task counts, concurrency and alarm thresholds from measurements.
2. **Extend the operator interface.** Add delivery documents with multiple lines and a reviewed offline workflow. The current responsive console already provides barcode reading, stable retry identities and operator attribution.
3. **Integrate suppliers and ERP systems.** Map partial receipts, producer references and units of measure; add reporting exports and durable webhooks.
4. **Expand audited movements.** Model transfers, returns, outbound shipments, bin allocation and compensating adjustments without rewriting historical receipts.
5. **Automate archival and recovery exercises.** Preserve permanent deduplication identities while archiving details; rehearse coordinated database and queue recovery.
6. **Improve reporting and warehouse isolation.** Add projections, per-warehouse latency metrics, optional dedicated queues and history time buckets when measured access patterns justify them.
