# Publish the frontend on Vercel

The static build presents the warehouse console without running the backend. It contains **fictional, read-only data** for 16 warehouses and 8 products, with sample balances, receiving history and clearly identified example operators. Visitors can explore the interface and look up products with a keyboard, USB/Bluetooth scanner or camera.

No AWS account, AWS credentials, environment variables, username or password are required. This publication does not authenticate users, register products, receive inventory, change passwords or persist demonstration data. Camera decoding happens in the browser; images are not uploaded. The decoder and its license notices are bundled with the static files.

The repository configuration prepares a deployable frontend. It does not create a Vercel project, establish a published URL or deploy AWS resources. The API, DynamoDB, SQS and Fargate setup remain a separate [deployment workflow](deployment.md).

## Preview and verify locally

Use Node.js 24 from the repository root:

```sh
npm ci
npm run preview:frontend
```

Open **http://127.0.0.1:4173** and select **Explorar demonstração**. The preview command first builds `dist/frontend`, then serves it on the loopback interface with the same security headers configured for Vercel. Stop the server with Ctrl+C. Docker and `.env` are not needed for this preview.

To verify the static publication separately:

```sh
npx playwright install chromium
npm run test:frontend
```

The browser test configuration builds and starts its own local server on port 4175. The connected backend tests continue to use their existing commands and environment.

For barcode lookup, open the printable labels at **http://127.0.0.1:4173/demo-barcodes.html**, or enter an example such as `7899000000010`. Camera use requires permission and a secure browser context, provided by HTTPS after publication or the loopback preview. A detected code identifies a sample product; confirming a real receiving movement is disabled.

## Import the repository

1. In Vercel, create a project by importing `helberjf/aws-warehouse-intake` from GitHub.
2. Use the repository root as the project's Root Directory.
3. Confirm the settings below. The committed `vercel.json` supplies the build configuration; select Node.js 24 in the project settings if necessary.
4. Leave application environment variables empty for this static demonstration.
5. Deploy and open the URL returned by Vercel. Verify the demonstration notice, warehouse navigation, product lookup and barcode labels on desktop and mobile.

| Setting                           | Repository value                          |
| --------------------------------- | ----------------------------------------- |
| Framework preset                  | Other (`framework: null`)                 |
| Install command                   | `npm ci`                                  |
| Build command                     | `npm run build:frontend`                  |
| Output directory                  | `dist/frontend`                           |
| Node.js                           | 24, bounded by `engines.node: ">=24 <25"` |
| Functions and API rewrites        | None                                      |
| Application environment variables | None                                      |

Vercel supports `null` for the Other framework preset and explicit build/output settings. Only the output directory is served statically. Node.js 24 is supported for builds. [Vercel configuration](https://vercel.com/docs/project-configuration/vercel-json), [build output settings](https://vercel.com/docs/builds/configure-a-build), [Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).

## Build and security boundary

`scripts/build-frontend.ts` clears only the fixed generated `dist/frontend` directory, then copies an explicit list of public assets and the local ZXing decoder/licenses. It generates a runtime configuration selecting preview mode. Server source, `.env`, `.tokens`, load-test reports and AWS configuration are not part of the public output.

The source runtime configuration selects connected mode for the existing Docker/API application. The build changes the generated copy, so publishing the demonstration does not replace the connected application's authentication or persistence.

The static headers retain the application's content-security policy, forbid framing, disable MIME sniffing, avoid referrer disclosure and allow camera access only for the page's own origin. Scripts and API connections are restricted to the same origin. Responses use `Cache-Control: no-store`. Keep these policies aligned when changing assets or hosting. [Vercel response-header configuration](https://vercel.com/docs/project-configuration/vercel-json#headers).

Do not add production credentials to client-side files or change preview mode to connected mode as a substitute for deploying and validating the backend. All shipped browser assets are public, regardless of whether the repository itself is private.

## Connecting the AWS backend later

The future integration should preserve the frontend's same-origin API model. The current client uses relative request paths and `credentials: 'same-origin'`; its content-security policy permits only same-origin connections. Vercel external rewrites can forward selected paths to a fixed HTTPS backend while retaining the browser URL. No rewrite or placeholder API URL is configured in this version. [External rewrites](https://vercel.com/docs/routing/rewrites).

Before enabling connected mode, implement and verify the following together:

- **Origin and paths.** Proxy the required authentication, product, warehouse and receiving paths to the deployed backend without changing their semantics. Set backend `PUBLIC_ORIGIN` to the exact HTTPS frontend origin, with no path or trailing slash. Preserve the browser's `Origin`, `Sec-Fetch-Site` and `X-CSRF-Token` headers. Changing a domain or using a preview deployment requires a deliberate trusted-origin configuration; do not allow arbitrary preview origins against production data.
- **Sessions and cookies.** Preserve request cookies and response `Set-Cookie`. The production cookie is `__Host-warehouse_session`, with `HttpOnly`, `Secure`, `SameSite=Strict` and `Path=/`, without a `Domain` attribute. Keep the cookie scoped to the browser's frontend host. Validate login, session reload, logout, password-change revocation and rejected CSRF requests through the actual proxy.
- **Authenticated response caching.** Preserve backend `Cache-Control: no-store`, and disable caching on forwarded application paths. New Vercel projects honor upstream cache headers on external rewrites by default; `x-vercel-enable-rewrite-caching: 0` explicitly disables rewrite caching. Do not add public cache directives to user/session/stock responses. [Rewrite caching](https://vercel.com/docs/routing/rewrites#disabling-caching-for-rewrites-to-external-origins), [CDN cache eligibility](https://vercel.com/docs/caching/cdn-cache).
- **Trusted proxy chain.** The API currently trusts its immediate ALB hop. Adding Vercel introduces another hop: otherwise the login limiter may identify the proxy's IP rather than the visitor. Restrict the origin to trusted proxy traffic and validate forwarded visitor identity before changing proxy trust. Do not blindly trust arbitrary forwarded headers or all hops. [Visitor identity and origin restrictions](https://vercel.com/docs/routing/rewrites#identifying-the-visitor-at-your-origin).
- **Timeouts and retries.** The browser currently times out requests after 25 seconds, the API has a 30-second request timeout, and Vercel documents a 120-second external-proxy limit. Receiving should still acknowledge durable acceptance promptly and complete asynchronously. Preserve the original idempotency key and body when retrying an ambiguous response. [Vercel proxy limit](https://vercel.com/docs/limits#proxied-request-timeout).

These checks concern the later AWS connection. The current static demonstration has no API destination and cannot modify warehouse data. Published frontend availability or successful local browser tests do not establish AWS deployment, backend availability or production throughput.
