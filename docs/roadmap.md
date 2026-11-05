# Implementation roadmap

## Foundation — included in the initial repository

- TypeScript strict domain validation for serialized and bulk receiving.
- Catalog-mode validation and deterministic business, HTTP replay, unit and warehouse-group identities.
- Generated JSON Schema and representative request examples.
- Executable arrival-rate planner with configurable daily units, mixing ratio, operating hours and peak multiplier.
- Automated contract and arithmetic tests; English architecture and data-model documents.

## 1. Durable receiving API

Build a containerized API with authenticated warehouse access, catalog lookup, required idempotency keys, atomic ledger/replay/outbox writes and status lookup. Publish OpenAPI contracts. Preserve business deduplication across HTTP-key changes and expiry. Add real DynamoDB Local transaction/concurrency tests. Acceptance evidence: retries return one entry and conflicting payloads never change stock.

## 2. Publisher and worker services

Implement sharded outbox queries, conditional leases, retry deadlines, warehouse-group SQS publication and the atomic inventory transaction. Add graceful shutdown, visibility management, bounded concurrency and poison-message handling. Acceptance evidence: failed publication remains recoverable, duplicate delivery creates one stock effect, and concurrent serial claims have one winner.

## 3. Reproducible AWS infrastructure

Define VPC/network access, ALB, ECS/Fargate services, ECR, DynamoDB, SQS/DLQ, IAM and CloudWatch in CloudFormation. Keep Lambda out of the application and automation path. Configure OIDC-based delivery with reviewed change sets and separate development/production environments. Review region, network design and estimated recurring cost before deployment.

## 4. Operational evidence

Run the capacity profiles with synthetic data, warehouse authorization checks, publisher/worker termination, backlog recovery and controlled DLQ redrive. Record observed throughput, p95/p99 latency, stock reconciliation and cost. Automate repeatable tests only after an isolated environment and budget are approved.

## 5. Business expansion

Add receiving documents with multiple lines, partial receipts, bin allocation, transfers, returns and compensating adjustments as separate explicit domain operations. Reporting, supplier integrations and ERP reconciliation follow the agreed access patterns. Preserve the immutable movement trail instead of manually overwriting stock totals.
