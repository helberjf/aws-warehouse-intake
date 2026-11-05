# Deployment and operations

The repository runs locally with containers and can deploy the same image as three ECS/Fargate services. No cloud resources are created by CI or by local development commands.

## Local environment

Install Docker Compose and Node.js 24.19.0, then run:

```sh
cp .env.example .env
npm ci
npm run check
docker compose up -d --build
docker compose ps
```

Compose starts DynamoDB/SQS emulation, provisions the local table and queues, creates a synthetic catalog, then starts the API, outbox publisher and worker. The API listens at `http://127.0.0.1:3000`; the emulator is at `http://127.0.0.1:4566`. Both ports bind only to localhost. Get a local token with `npm run local:token`, and use it as a Bearer token. Local signing credentials are deliberately public demo values and are rejected by production configuration.

The sample organization is `DEMO`, warehouses are `WH-01` and `WH-02`, and products are `BULK-001` and `SERIAL-001`. Local state is disposable: stopping and recreating the emulator can erase it. No AWS credentials are required.

```sh
npm run test:integration
docker compose logs --tail 100 api publisher worker
docker compose down
```

LocalStack is pinned to the last-generation Community line, `4.12.0`, so local development does not require a LocalStack account. That version is an isolated test dependency, never a production service; it no longer receives maintenance updates. The [LocalStack announcement](https://blog.localstack.cloud/the-road-ahead-for-localstack/) explains the account requirement for newer images. Emulation cannot establish AWS throughput, IAM correctness, network reachability or fair-queue scheduling guarantees.

## AWS prerequisites

Provision or select these resources in the same AWS account and Region before creating the application stack:

- An existing VPC with DNS support, at least two public subnets and two private subnets in different Availability Zones.
- A public route to an internet gateway for the ALB. Private tasks need outbound HTTPS through NAT or the appropriate VPC endpoints. ECR API/Docker, S3 image layers, CloudWatch Logs, DynamoDB and SQS must be reachable. The API must also reach the identity provider's JWKS endpoint; private AWS endpoints alone do not provide that external route.
- A domain name and a validated ACM certificate covering that domain. Create a DNS alias to the stack's load balancer after deployment and access the API using the certificate's hostname.
- A trusted JWT identity provider with HTTPS issuer and JWKS endpoint. It must issue the documented organization, producer, warehouse and role claims. Assign these claims server-side; warehouse operators must not be able to grant themselves access.
- An optional existing SNS topic for alarms, with subscriptions configured by the operator.
- An IAM deployment principal permitted to create the declared resources and pass only the six task/execution roles in this stack. Application services themselves do not receive deployment permissions.

NAT, ALB, Fargate, logs, Container Insights and retained data incur charges even when receiving traffic is low. Set an AWS budget and choose a Region before deployment. The template starts two API tasks, two worker tasks and one publisher task. These are availability defaults, not a measured capacity recommendation.

## Build and publish an immutable image

The following PowerShell example uses a configured AWS CLI identity and creates AWS resources when executed. Choose the account and Region deliberately.

```powershell
aws sts get-caller-identity
aws cloudformation deploy --stack-name warehouse-registry --template-file infra/registry.json
$repository = aws cloudformation describe-stacks --stack-name warehouse-registry --query "Stacks[0].Outputs[?OutputKey=='RepositoryUri'].OutputValue | [0]" --output text
$registry = $repository.Split('/')[0]
$revision = git rev-parse HEAD
aws ecr get-login-password | docker login --username AWS --password-stdin $registry
docker build --platform linux/amd64 --tag "${repository}:${revision}" .
docker push "${repository}:${revision}"
$repositoryName = $repository.Substring($repository.IndexOf('/') + 1)
$digest = aws ecr describe-images --repository-name $repositoryName --image-ids "imageTag=$revision" --query "imageDetails[0].imageDigest" --output text
Write-Output "${repository}@${digest}"
```

The registry uses immutable tags and scanning on push. Review its scan findings before deployment. Record the repository ARN output too. Use a digest URI as `ImageUri`; mutable tags are rejected by the application template.

## Review and deploy the application

Create a local parameter file outside version control, using the following keys:

| Parameter                                | Value                                                        |
| ---------------------------------------- | ------------------------------------------------------------ |
| `VpcId`, `VpcCidr`                       | Existing VPC ID and CIDR                                     |
| `PublicSubnetIds`, `PrivateSubnetIds`    | Comma-separated subnet IDs in separate Availability Zones    |
| `CertificateArn`                         | Validated ACM certificate ARN                                |
| `ImageUri`, `RepositoryArn`              | Immutable image digest URI and its ECR repository ARN        |
| `JwtIssuer`, `JwtAudience`, `JwtJwksUrl` | Trusted identity-provider configuration                      |
| `AlarmTopicArn`                          | Existing SNS topic ARN, or an empty string                   |
| `ApiMinTasks`, `ApiMaxTasks`             | Defaults 2 and 10; maximum must be at least minimum          |
| `WorkerMinTasks`, `WorkerMaxTasks`       | Defaults 2 and 20; maximum must be at least minimum          |
| `BacklogPerWorker`                       | Initial target 100; tune after measuring processing duration |

Use CloudFormation's parameter-file format: an array of `{"ParameterKey":"VpcId","ParameterValue":"vpc-..."}` objects. A parameter file contains deployment-specific data and belongs in the ignored `.deploy/` directory.

```powershell
aws cloudformation create-change-set --stack-name warehouse-intake --change-set-name initial-review --change-set-type CREATE --template-body file://infra/service.json --parameters file://.deploy/parameters.json --capabilities CAPABILITY_IAM
aws cloudformation wait change-set-create-complete --stack-name warehouse-intake --change-set-name initial-review
aws cloudformation describe-change-set --stack-name warehouse-intake --change-set-name initial-review
aws cloudformation execute-change-set --stack-name warehouse-intake --change-set-name initial-review
aws cloudformation wait stack-create-complete --stack-name warehouse-intake
```

For later releases, use `UPDATE`, a unique change-set name and the new image digest. Keep the previous digest for rollback. ECS circuit breakers stop failed rollouts and roll back to the last completed deployment. Avoid changing task minimums at the same time as traffic assumptions without reviewing the scaling impact.

The table, queues, log groups and image repository are retained on stack removal. Table deletion protection and ALB deletion protection are enabled. Retirement therefore requires a deliberate archival and retention procedure, disabling ALB deletion protection before removing the stack; retained data continues to incur charges.

## Release verification

After deployment, use the actual HTTPS hostname to verify the following with controlled synthetic data:

1. Health/readiness respond successfully, anonymous receiving is rejected, and wrong-warehouse access fails.
2. An administrator registers the warehouse and catalog products. A receiving identity submits one bulk entry and one serialized entry, observes `ACCEPTED` followed by `APPLIED`, and reads the correct balances.
3. Replay the same HTTP key, then the same business reference with a new HTTP key. Balances remain unchanged. Changed data under either identity returns a conflict.
4. Receive the same serial into another warehouse in the same organization. The second entry becomes `REJECTED`, with no balance increase.
5. Stop a publisher/worker task during processing and verify eventual completion without repeated stock changes. ECS replaces the task.
6. Run representative sustained, burst and hot-SKU tests from [capacity planning](capacity.md). Record API latency, acceptance/application counts, queue age, rejection counts, task counts and cost.

Do not run destructive failure experiments with live warehouse records. A successful local integration run is evidence for application behavior, not evidence of cloud capacity or production recovery.

## Monitoring, scaling and recovery

API and worker services scale independently on CPU; workers additionally use queue backlog per running task. Container Insights supplies the running task count. The target expression protects against a zero divisor, while minimum capacity remains two. [AWS explains how to choose a backlog target](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-autoscaling-queue.html). The publisher starts with one task; outbox leases permit multiple publishers when measurements justify increasing its service count.

CloudWatch alarms cover queue age, DLQ backlog, API server errors and repeated publisher/worker failures. Background failure metrics come from structured log filters, so an outbox publishing outage can trigger an alarm before any SQS backlog appears. Attach the `AlarmTopicArn` parameter to receive notifications; without it, alarms still record state but do not notify an operator. Investigate sustained publisher failures immediately and use the due-index to inspect overdue records without scanning the table.

Messages move to the DLQ after five receives. First fix the underlying fault, inspect affected entry IDs and their ledger status, and then perform a controlled SQS redrive with a bounded rate. Redelivered messages are safe because stock application is transactional and idempotent. Never fabricate a new business reference to repair a retry, and never delete a ledger identity to force processing.

DynamoDB point-in-time recovery is enabled. A restore creates a new table. Reconcile ledger, balances, unit registry and pending outbox together before moving traffic to a restored table; reverting data while keeping an independently advanced queue can reintroduce historical deliveries. Exercise this procedure in a separate environment and document the recovery point.

JWT keys rotate through the provider's JWKS endpoint. The application uses task roles, so AWS access keys are absent from ECS configuration. Restrict administrator tokens, rotate identity-provider credentials through that provider, and keep authentication headers out of logs.
