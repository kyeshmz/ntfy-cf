# ntfy-cf implementation plan

## Goal

Build and deploy a private, Workers-native ntfy-compatible notification service named `ntfy-kyeshimizu`. It must support direct HTTP clients and publishing from other Cloudflare Workers through a service binding.

## Scope

### Included

- Publish text or JSON notifications with ntfy-compatible fields.
- Subscribe using WebSockets at `/<topic>/ws`.
- Poll cached messages as NDJSON at `/<topic>/json?poll=1` with `since` support.
- Persist bounded topic history in one SQLite Durable Object per topic.
- Authenticate publish and subscribe requests with a single bearer token stored as a Worker secret.
- Expose a typed WorkerEntrypoint RPC method for service-binding publishers.
- Provide health/readiness endpoint, structured logs, tests, and deployment instructions.

### Excluded from v1

- Android FCM and iOS/APNs forwarding.
- The upstream ntfy web application and account/ACL management.
- SSE and indefinite HTTP streaming.
- Uploaded attachments, R2 storage, email, calls, scheduled delivery, and UnifiedPush.
- Full drop-in compatibility with the upstream Go server.

## Architecture

- The public Worker validates routing, topics, payload sizes, and bearer authentication.
- A `Topic` SQLite Durable Object is selected deterministically with `getByName(topic)`.
- Publishing is an RPC call to the topic object. It inserts first, prunes expired/excess history, then broadcasts to hibernating WebSockets.
- WebSocket upgrades are forwarded to the topic object. Connections use the Durable Objects Hibernation API.
- Poll requests call the topic object over RPC and return ntfy-style NDJSON.
- Other Workers bind to this Worker and call a typed `publish(topic, notification)` RPC method. Service-binding calls do not require the public bearer token.

## Implementation stages

1. Scaffold TypeScript, Wrangler, Durable Object, routing, validation, auth, and RPC publish API.
2. Add ntfy-compatible publish parsing, durable history, polling semantics, and hibernating WebSockets.
3. Add Worker-runtime tests covering auth, validation, publishing, polling, metadata, and WebSockets.
4. Add README deployment/setup instructions, service-binding examples, compatibility notes, and smoke tests.
5. Run generated binding types, typecheck, tests, lint/format checks, dry-run deployment, and startup profiling where supported.
6. Authenticate Wrangler, deploy as `ntfy-kyeshimizu`, configure the publish token secret, and run remote smoke tests. Deployment must stop and report clearly if Cloudflare credentials or a token value are unavailable.

## Acceptance criteria

- `POST /alerts` with a valid bearer token returns an ntfy-style message object.
- `GET /alerts/json?poll=1&since=all` returns persisted messages as NDJSON.
- `GET /alerts/ws` upgrades and receives newly published message JSON.
- Invalid topics, oversized payloads, unsupported routes, and invalid credentials return explicit 4xx responses.
- A bound Worker can invoke `publish()` without public HTTP or embedded Cloudflare API credentials.
- All automated verification passes and a Wrangler dry run succeeds.
