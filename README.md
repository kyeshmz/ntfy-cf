# ntfy-cf

`ntfy-cf` is a private, Workers-native subset of the ntfy API. The deployed
Worker is named `ntfy-kyeshimizu`.

## Architecture

The public `NtfyWorker` validates topics, routes, request sizes, and the
`Authorization: Bearer ...` token. Each topic is mapped to one SQLite Durable
Object (`Topic`) with `getByName(topic)`. The object stores at most 100
messages for up to 7 days, serves poll requests, and broadcasts new messages
to hibernating WebSockets.

The HTTP API requires the bearer token for publishing, polling, and WebSocket
subscription. A Worker service binding invokes the typed `publish()` RPC on
`NtfyWorker`; that private path does not require the HTTP token.

Agents can use the same service through the authenticated Streamable HTTP MCP
endpoint at `/mcp`. It exposes `publish_notification` and `get_notifications`.

Topics must match `[A-Za-z0-9._-]+` and be no longer than 128 characters.
HTTP bodies and RPC notifications are limited to 64 KiB. Published messages
use ntfy-style JSON objects with `event`, `id`, `time`, `topic`, `message`, and
optional metadata such as `title`, `tags`, `priority`, `click`, `actions`,
`attach`, `filename`, `email`, `call`, and `icon`.

## Local Development

Create a local-only `.dev.vars` file (it is ignored by Wrangler):

```dotenv
PUBLISH_TOKEN=replace-with-a-local-random-token
```

Start the Worker:

```sh
npm install
npm run types
npx wrangler dev
```

Use the same value from `.dev.vars` in the examples below. Do not commit
`.dev.vars` or place a token in source code, shell history, or documentation.

## HTTP API

Set a shell variable to a token you created locally or stored in your secret
manager:

```sh
export NTFY_TOKEN='replace-with-the-token-from-your-local-environment'
export NTFY_URL='http://localhost:8787'
```

Publish plain text with ntfy-compatible headers:

```sh
curl -sS -X POST "$NTFY_URL/alerts" \
  -H "Authorization: Bearer $NTFY_TOKEN" \
  -H 'Title: Build finished' \
  -H 'Tags: white_check_mark,ci' \
  -H 'Priority: 4' \
  --data-raw 'release 42 is ready'
```

Publish JSON metadata:

```sh
curl -sS -X POST "$NTFY_URL/alerts" \
  -H "Authorization: Bearer $NTFY_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"message":"Deploy finished","title":"Production","priority":3,"tags":["deploy"]}'
```

Poll the bounded topic history as newline-delimited JSON. `since=all` (or no
`since`) returns retained history; a Unix timestamp returns later messages;
an existing message ID returns messages after that ID.

```sh
curl -sS "$NTFY_URL/alerts/json?poll=1&since=all" \
  -H "Authorization: Bearer $NTFY_TOKEN"
```

Check readiness:

```sh
curl -i "$NTFY_URL/healthz"
```

The WebSocket endpoint is `/<topic>/ws`. A curl handshake is useful for a
smoke check, but curl is not a WebSocket client and will not conveniently
consume subsequent frames:

```sh
curl --http1.1 -i -N "$NTFY_URL/alerts/ws" \
  -H "Authorization: Bearer $NTFY_TOKEN" \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  --max-time 5
```

For a live subscription, use a WebSocket client such as `websocat` and use
`ws://localhost:8787/alerts/ws` with an `Authorization` header. The first
frame is an `open` event; future publishes arrive as `message` events.

## Bearer Token

The token is a single Worker secret, not an ntfy user/account credential.
Configure it after authenticating Wrangler:

```sh
npx wrangler secret put PUBLISH_TOKEN --name ntfy-kyeshimizu
```

Paste the token only when Wrangler prompts. The command does not belong in CI
logs or committed files. Requests without exactly the configured bearer
token receive `401 Unauthorized`.

## Deployment

The checked-in Wrangler configuration already names the service
`ntfy-kyeshimizu`, enables Workers Observability, and declares the `Topic`
SQLite Durable Object migration. Deploy with:

```sh
npx wrangler deploy
npx wrangler secret put PUBLISH_TOKEN --name ntfy-kyeshimizu
```

Use the deployed HTTPS URL as `NTFY_URL` and `wss://` instead of `ws://` for
the WebSocket smoke check. Never print or commit the secret.

## Service Bindings and Typed RPC

In a consuming Worker's `wrangler.jsonc`, bind the named RPC entrypoint:

```jsonc
{
  "services": [
    {
      "binding": "NTFY",
      "service": "ntfy-kyeshimizu",
      "entrypoint": "NtfyWorker"
    }
  ]
}
```

Generate the consuming Worker's binding types with Wrangler, including the
publisher Worker's config and this Worker's config when they are separate
projects:

```sh
npx wrangler types -c wrangler.jsonc
```

The generated `Env.NTFY` is typed from the exported `NtfyWorker` entrypoint.
Call it without HTTP credentials:

```ts
const notification = await env.NTFY.publish("alerts", {
  message: "Published from another Worker",
  title: "Internal job",
  tags: ["worker"],
  priority: 3,
});
```

See [`examples/worker-publisher.ts`](examples/worker-publisher.ts) for a
complete publisher entrypoint. Service bindings are private Worker-to-Worker
calls; do not expose the binding object to untrusted request data.

## OpenCode Plugin, MCP, and Agent Skill

The repository includes a project-local OpenCode plugin, MCP configuration, and skill:

- `.opencode/plugins/ntfy-cf.js` automatically sends lifecycle notifications.
- `opencode.jsonc` connects the deployed `/mcp` endpoint.
- `.opencode/skills/ntfy-cf/SKILL.md` teaches agents when and how to notify.

Set the token before starting OpenCode from this repository:

```sh
export NTFY_CF_TOKEN='replace-with-your-worker-secret'
export NTFY_CF_TOPIC='agent-status'
opencode2
```

OpenCode discovers the plugin, the `ntfy-cf` skill, and the `ntfy` MCP server
automatically. The plugin sends notifications when a root session finishes,
encounters an error, or requests permission. Child-session completion and error
events are suppressed. Set `NTFY_CF_URL` to override the deployed Worker URL.
Delivery failures are logged and never interrupt the OpenCode session.
The plugin targets OpenCode's V2 event API; preview builds that do not yet
expose `ctx.event.subscribe()` load the plugin but disable automatic events.

The MCP uses header authentication rather than OAuth and supports stateless
Streamable HTTP JSON-RPC requests. Do not commit the token to OpenCode config.

Other MCP clients can connect to:

```text
https://ntfy-kyeshimizu.kyeshimizu.workers.dev/mcp
```

Send `Authorization: Bearer <token>` on every request. The endpoint implements
MCP `initialize`, `ping`, `tools/list`, and `tools/call`; it has no runtime MCP
framework dependency and does not bundle Zod.

## Verification and Operations

Run the local automated smoke suite and typecheck:

```sh
npm test
npm run typecheck
```

For a deployed smoke test, verify `/healthz`, publish to a disposable topic,
poll it with `since=all`, and perform the WebSocket handshake. Confirm that a
request with a missing or wrong bearer token returns `401` and that an invalid
route returns `404`.

Workers Observability is enabled in `wrangler.jsonc` with full head sampling.
Use the Cloudflare dashboard or Wrangler logs to inspect structured events
such as `publish` and `websocket_error`. Durable Object history is bounded and
is not a replacement for an audit log or archival store.

## Compatibility Limits

This is not a drop-in replacement for the upstream Go server. v1 does not
implement:

- The upstream web application, user accounts, access control lists, or topic management.
- Android FCM, iOS/APNs forwarding, UnifiedPush, or other mobile delivery.
- SSE, indefinite HTTP streaming, or long-poll subscriptions.
- Attachments/uploads, attachment storage, email delivery, voice calls, or R2 integration.
- Scheduled or delayed delivery. A `delay` field is rejected.
- Upstream server features not listed in this README, including full auth and admin APIs.

The service provides in-process notification history and live WebSocket
delivery only. Metadata fields are carried in notification objects; they do
not activate external delivery providers.
