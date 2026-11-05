# API and authentication

The [OpenAPI 3.1 contract](../schemas/openapi.json) is served by `GET /openapi.json`. All business routes require `Authorization: Bearer <token>`. Public routes are `/health`, `/ready` and `/openapi.json`.

| Method and path                                             | Behavior                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| `PUT /products/{skuId}`                                     | Administrator sets `{trackingMode,active}`; mode cannot change |
| `PUT /warehouses/{warehouseId}`                             | Administrator with warehouse access sets `{name,active}`       |
| `POST /warehouses/{warehouseId}/receiving-entries`          | Required Idempotency-Key;202 and Location header               |
| `GET /warehouses/{warehouseId}/receiving-entries/{entryId}` | Consistent scoped status                                       |
| `GET /warehouses/{warehouseId}/receiving-entries`           | Recent-first, eventually consistent history                    |
| `GET /warehouses/{warehouseId}/stock/{skuId}`               | Consistent balances by lot                                     |

Lists accept `limit`1..100 (default 50) and the opaque `cursor` returned by the previous response. Keep the same warehouse/SKU scope. Pagination is not a point-in-time snapshot during concurrent writes.

## Identity-provider contract

Production requires `ENVIRONMENT=production`, `JWT_ISSUER`, `JWT_AUDIENCE` and HTTPS `JWT_JWKS_URL`. Tokens must use RS256 and contain `sub`, `iat`, `exp`, the configured issuer/audience and custom claims:

```json
{
  "organizationId": "ACME",
  "producerId": "receiving-erp",
  "warehouseIds": ["WH-01", "WH-02"],
  "roles": ["receiving"]
}
```

Use `roles:["admin"]` for administration. Both roles may read and receive within their warehouse grants. Admin does not grant wildcard access. The identity provider must control these claims; they must not be self-editable profile fields. Provision warehouse grants before administrator registration.

`producerId` is a stable logical source shared by retries across devices; `sub` identifies the token holder. The current immutable movement records the producer namespace, not an individual operator audit trail.

The verifier checks signature, algorithm, issuer, audience, expiration and principal shape with five seconds of clock tolerance. Caller-supplied key URLs are ignored. Use short token lifetimes: already issued JWTs retain their claims until expiration unless signing-key removal and verifier cache refresh invalidate them.

Local mode uses explicit HS256 demo signing. Production refuses local secrets and emulator endpoints. The local token script cannot create production credentials.

## Receiving contract

```json
{
  "mode": "SERIALIZED",
  "skuId": "SERIAL-001",
  "serialNumber": "UNIT-0001",
  "externalReference": "delivery-001-line-2-unit-1",
  "occurredAt": "2026-11-05T12:00:00Z"
}
```

Serialized entries represent one unit. Bulk entries use mode BULK, integer quantity from 1 to 1,000,000 and optional lotCode, with no serialNumber. Identifiers are case sensitive. Unknown fields, including ownership fields, are rejected. Maximum body size is 16 KiB. Product mode must match the catalog.

A reference names one movement in the organization/warehouse/producer namespace. Partial receipts require distinct references. Reuse the exact original body on retry, including occurredAt. Different data under the same reference or HTTP key returns 409. Exact replay returns the original entry identity with current status.

New receipts require an active product and warehouse within the acceptance transaction. Deactivation blocks future receipts but does not cancel accepted work. Receiving a registered serial as a new movement becomes REJECTED with SERIAL_ALREADY_RECEIVED.

## Error handling

Errors use `{error:{code,message},requestId}`. Invalid fields/JSON/cursors return 400, invalid authentication 401, insufficient access 403, unavailable scoped records 404, identity/eligibility conflicts 409, oversized bodies 413 and unsupported media 415. Unexpected dependency failures return generic 500.

For network failures and retryable 5xx responses use bounded backoff with jitter, preserving body, key and reference. A timeout may occur after durable acceptance. Query the known entry or replay to resolve uncertainty; never create a new reference merely because a request failed.
