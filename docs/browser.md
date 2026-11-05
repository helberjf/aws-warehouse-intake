# Browser interface, accounts and barcode receiving

The Portuguese interface is served by the same API container at `/`. It provides sign-in, product registration, receiving history and stock by warehouse. Browser requests use the existing DynamoDB/SQS workflow; the frontend does not maintain a separate inventory database.

## Start locally

```powershell
npm ci
npm run local:configure
docker compose up -d --build
```

Open `http://localhost:3000` after readiness succeeds. The configured origin is exact: use `localhost`, rather than substituting `127.0.0.1`, when signing in.

The configuration helper creates a random local administrator password if none exists, stores it in ignored `.env`, and writes the local sign-in details to ignored `.tokens/local-login.txt`. The organization is `DEMO` and the default username is `admin`. No password is committed to the public repository. Protect both local files on shared computers. The demo password belongs only to this disposable environment.

Compose setup provisions the local administrator and demo catalog. Existing accounts are preserved when setup runs again; editing `.env` alone does not reset their database password. Use the password-change screen while signed in or an explicit administrator reset. Recreating the disposable emulator may remove its records; the configured local administrator is created again by setup.

## Accounts and production authentication

Browser accounts are stored in DynamoDB. Passwords use salted asynchronous scrypt hashes; plaintext passwords are never written to user records. An account has a stable user ID, display name, organization, producer namespace, explicit warehouse grants, roles and active state. Administrators can register products; receiving users can record entries and consult stock in their granted warehouses. There is no public signup endpoint.

Provision a production account from a trusted operator environment with the required DynamoDB permissions. Configure `ENVIRONMENT=production`, the real `TABLE_NAME` and `AWS_REGION`, and remove any emulator endpoint. Supply the secret through standard input, not a command-line argument, committed file or literal example password. This PowerShell example prompts privately and pipes the completed JSON object directly to the provisioning tool:

```powershell
$securePassword = Read-Host 'New account password' -AsSecureString
$env:WAREHOUSE_NEW_USER_PASSWORD = [System.Net.NetworkCredential]::new('', $securePassword).Password
try {
  @{
    organizationId = 'ACME'
    username = 'receiving.admin'
    password = $env:WAREHOUSE_NEW_USER_PASSWORD
    displayName = 'Receiving administrator'
    producerId = 'warehouse-ui'
    warehouseIds = @('WH-01', 'WH-02')
    roles = @('admin', 'receiving')
    active = $true
  } | ConvertTo-Json -Compress | node scripts/create-user.ts
} finally {
  Remove-Item Env:WAREHOUSE_NEW_USER_PASSWORD -ErrorAction SilentlyContinue
  $securePassword.Dispose()
}
```

For local account provisioning, use `node --env-file=.env scripts/create-user.ts` in the pipeline. Passwords must contain 12 through 128 characters. Usernames are trimmed and normalized to lowercase; organization and warehouse IDs remain case sensitive. The tool refuses to overwrite an existing account unless `--reset` is explicit. An explicit reset preserves the stable user ID, replaces the supplied account attributes, and rotates the credential version so earlier sessions become invalid. Setting `active=false` during such a controlled update disables the account. Keep the same `producerId` for the same logical receiving source so retry identities remain stable across operators.

Production requires an exact HTTPS `PUBLIC_ORIGIN`, such as the application's certificate-backed hostname with no trailing slash or path. Optional RS256/JWKS settings support external machine integrations; browser password login does not require an external JWT identity provider. If configured, machine JWTs retain their existing organization, producer, role and warehouse claim contract.

## Session behavior

`POST /auth/login` accepts organization, username and password and returns the user profile, CSRF token and expiry. The opaque session ID is delivered only in an HttpOnly cookie. Production uses `__Host-warehouse_session` with `Secure`, `SameSite=Strict` and `Path=/`; local development uses `warehouse_session`. The database stores a hash of the session ID. Sessions expire after eight hours, and expiration is checked logically even before DynamoDB TTL deletion occurs.

The frontend reads its current identity through `GET /auth/session`. Every cookie-authenticated mutation sends `X-CSRF-Token`; the server also requires an `Origin` that exactly matches `PUBLIC_ORIGIN`. Login itself requires this trusted origin. Cookies and passwords are not stored in browser local storage. If a session cookie is present but invalid, the request cannot bypass that failure with a Bearer token.

`POST /auth/logout` revokes the current session. `POST /auth/password` requires the current password, validates the new password, and invalidates all earlier sessions by changing the credential version. The user signs in again afterward. Account activity and credential version are checked on every session-authenticated request.

Distributed login limits use DynamoDB rather than per-container memory: five attempts per account and thirty per client IP within fifteen minutes, including successful attempts. Password changes have a separate five-attempt account limit. A throttled response returns `429` and `Retry-After: 900`. Do not repeatedly retry an invalid password from an automated scanner. Deployment must preserve the trusted ALB-to-task boundary when forwarding client IP information.

## Product and receiving attribution

Product registration captures `createdBy.subject`, the display-name snapshot and server-generated `createdAt`. Later edits retain that original attribution and update `updatedBy`/`updatedAt`. The authenticated operator is supplied by the server; request bodies cannot choose or replace these fields.

Receiving records capture `recordedBy` from the verified session or machine JWT subject. Exact retries retain the original acceptance identity and operator even if another authorized user retries the same movement. `acceptedAt` records server acceptance time; `occurredAt` records the UTC event timestamp supplied by the client. These timestamps have different meanings.

Existing records created before actor capture can have no creator or operator. The interface shows missing historical attribution instead of assigning the current user retroactively. The migration command also leaves those audit fields untouched. Demo products seeded by setup identify the demonstration system as their creator.

## Barcode workflow

1. Register the product's internal SKU, name, tracking mode and optional barcode. SKU and barcode share a unique, case-sensitive code namespace within the organization. A conflicting code is rejected atomically; the same code can exist in a different organization.
2. Select the destination warehouse on the receiving screen.
3. Focus the code field and scan with a USB/Bluetooth reader that emulates a keyboard. Configure the device to send Enter after the code, or press Enter manually. The same field supports typing a code.
4. Alternatively, select **Ler com a câmera** and allow the browser to use the camera. The decoder first tries the browser's `BarcodeDetector`, then a locally served ZXing decoder. Camera images remain in the browser; only the decoded code is sent to the API.
5. Confirm the resolved product. Bulk entries default to one unit and allow a different quantity and an optional lot. Serialized products require the unit's serial number: a model/product barcode cannot infer an individual serial number.
6. Confirm the entry. Product code and tracking mode come from the catalog; the interface generates the UTC timestamp, business reference and HTTP idempotency key, while the server captures the operator and acceptance time.

Camera access requires HTTPS or the browser's trusted localhost context, a camera device and permission. Denied permission, unsupported devices and unreadable labels have a keyboard/manual fallback. Decoder availability does not establish physical-camera compatibility on every phone or barcode label; test the actual warehouse devices, lighting and printed codes before rollout.

The camera stops after the first recognized code, when the dialog closes or when the screen changes. Reading a code prepares the form; it does not silently register another receipt for every video frame. The operator confirms quantity or serial information before stock acceptance.

After an uncertain network response, the interface retains one pending request in tab-scoped `sessionStorage`, bound to the same user, organization and warehouse. Retry uses the same body, timestamp, reference and key. It does not invent another movement to bypass uncertainty. Session IDs and passwords are not included in that pending request. A new intentional receipt receives a new reference. After acceptance, follow status until `APPLIED` or `REJECTED`; `202` alone does not mean the stock balance has changed.

## Upgrading existing data

Fresh environments create `catalog-index` and `stock-index` with the table. They support bounded catalog and all-stock queries without request-time table scans. Existing SKU-specific stock reads remain consistent; index-backed lists are eventually consistent.

For an existing deployment, pause catalog/receiving writes and plan these steps before enabling the new browsing workflow:

1. Add `catalog-index` using a reviewed intermediate infrastructure change and wait until it is active.
2. Add `stock-index` in a second reviewed table/infrastructure update and wait until it is active. DynamoDB permits only one GSI creation per table update; do not submit both additions in one upgrade to an existing table. See [deployment](deployment.md) for change-set review.
3. Run the administrative metadata backfill in dry-run mode for the explicit organization and warehouse scope. It uses a bounded paginated scan because the legacy rows do not yet contain browse-index fields.
4. Resolve code conflicts, then repeat with `--apply`. This conditionally claims code aliases and writes only index metadata. It never rewrites stock quantities, original creator attribution or receiving identities.
5. Resume with the returned `nextCursor` until `complete=true`. Exit code `2` indicates that the bounded pass needs another page; exit code `1` indicates a failure such as conflicting codes or a concurrent edit. Rerunning completed pages is safe.
6. Verify catalog lookup, warehouse stock and reconciliation before resuming operators. Legacy barcode conflicts must be resolved deliberately; the migration refuses to overwrite another SKU's alias.

Local example, with `.env` pointing at the disposable emulator:

```powershell
npm run migrate:indexes -- --organization DEMO --warehouses WH-01,WH-02 --max-items 1000
npm run migrate:indexes -- --organization DEMO --warehouses WH-01,WH-02 --max-items 1000 --apply
```

If the report supplies `nextCursor`, use its exact value on the next invocation with the same organization and warehouse scope, for example `--cursor $checkpoint`. Dry-run reports candidate counts; conflicting aliases are enforced transactionally in apply mode. The application task role does not need scan permissions; grant the migration operator the separate permissions required for this deliberate administrative operation. Never point local setup or demo provisioning at a production database.

The complete route contract is in [OpenAPI](../schemas/openapi.json); backend recovery procedures are in [operations](operations.md). Browser and hardware validation evidence should be recorded separately from the backend's earlier local load measurements.
