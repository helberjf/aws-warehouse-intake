# Receiving contracts and proposed DynamoDB model

## Identity and boundaries

An organization owns warehouses and its SKU catalog. The API derives organization identity and allowed warehouses from authenticated access, then resolves the requested SKU from that organization's catalog. `producerId` identifies a stable logical source such as an ERP or receiving application; it is not a newly generated terminal/session ID. Two operators representing the same receiving source use the same producer namespace.

One `externalReference` names one physical receiving movement in an organization/warehouse/producer namespace. It can encode a delivery line and partial-receipt sequence. The reference is required for both modes. A new HTTP idempotency key must not permit recording the same physical movement twice.

The helper hashes JSON arrays to avoid ambiguous delimiter concatenation. SKU and serial identifiers are case sensitive after trimming. `occurredAt` is a client-reported UTC timestamp; the eventual API also records its own acceptance time and must not treat the client timestamp as authoritative audit time.

## Request contracts

- `SERIALIZED`: `skuId`, `serialNumber`, `externalReference`, `occurredAt`. One unit per movement; a client-supplied quantity is rejected.
- `BULK`: `skuId`, integer `quantity` from 1 to 1,000,000, optional `lotCode`, `externalReference`, `occurredAt`.
- Unknown body fields are rejected. Organization, warehouse, producer and permissions are not accepted from body ownership fields.
- The server-resolved product catalog must match both SKU and tracking mode. Tracking mode changes for a SKU with stock require a deliberate migration.
- This initial contract represents countable units. Weighed goods and fractional units of measure require a separate quantity model.

The generated [schema](../schemas/receiving-entry.schema.json) describes the body shape. Cross-record authorization and product-catalog checks remain server responsibilities and cannot be expressed by that body schema alone.

## Proposed access patterns

| Record              | Primary key                                                            | Access pattern and retention                                                               |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Receiving ledger    | `entryId = SHA256(org, warehouse, producer, externalReference)`        | Consistent lookup and conditional final transition; retain business deduplication identity |
| HTTP idempotency    | `SHA256(org, warehouse, producer, Idempotency-Key)`                    | Original acceptance response and request hash; temporary retention with logical expiry     |
| Outbox              | `ReceivingAccepted:<entryId>`                                          | Direct read/update; sparse GSI on versioned pending shard and due timestamp                |
| Stock balance       | Partition: `SHA256(org, warehouse, sku)`; sort: canonical lot identity | Atomic addition per SKU/lot; query lots for a SKU; no TTL                                  |
| Serialized unit     | `SHA256(org, sku, serialNumber)`                                       | Conditional uniqueness across warehouses within one organization; no TTL                   |
| Product catalog     | Organization + SKU                                                     | Authoritative tracking mode and active state                                               |
| Warehouse directory | Organization + warehouse                                               | Operational identity and active state; authorization additionally checks caller membership |

Define a canonical sentinel for “no lot” that cannot collide with a real lot value; a tagged tuple such as `['NO_LOT']` versus `['LOT', lotCode]` can be hashed. Do not put an entire day's products or all warehouse stock into one growing DynamoDB item.

For history, use an organization/warehouse/time-bucket index and pagination. Index results are eventually consistent; direct entry status reads can be consistent. History and reporting are separate from the write-critical path. Measure the most active SKU/lot before choosing balance sharding: sharding spreads writes but makes exact aggregate reads more expensive. [AWS partition-key guidance](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html).

## Transaction boundaries

Acceptance transaction:

1. Conditionally put the ledger entry with `ACCEPTED`, normalized request hash and receiving details.
2. Conditionally put the HTTP replay record.
3. Put the deterministic outbox intent.

On conflict, compare existing hashes and scope: identical requests replay the original entry; changed data under the same key/reference returns `409`. Business reference protection outlives temporary HTTP replay records. Apply warehouse/catalog eligibility checks at the chosen transactional boundary and define how deactivation affects already accepted entries.

Application transaction:

1. Conditionally change that ledger entry from `ACCEPTED` to `APPLIED`.
2. Atomically add the quantity to the warehouse/SKU/lot balance.
3. For serialized units, conditionally create the unique-unit record.

These writes must commit together. Never acknowledge a queue message merely because a balance update was attempted. The API returns `202` for durable acceptance; `APPLIED` is the completed stock effect. A duplicate physical unit is a business rejection, not an endless infrastructure retry.

## Retention and reconciliation

Archive large audit details only while retaining compact business deduplication identities and the necessary serialized-unit history. Deleting those identities can make old replays look new. Outbox TTL is for successfully published records only; balances have no expiry.

At 100,000 individual movements/day, a year can contain about 36.5 million ledger entries before retries or indexes. Define audit, archival and replay horizons from business needs, not by copying a short TTL from a demonstration project. A reconciliation job should compare ledger-derived received quantities with balances using controlled exports or projections, rather than request-time scans.
