import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RPC_BYTES = 64 * 1024;
const MAX_TOPIC_LENGTH = 128;
const MAX_HISTORY = 100;
const HISTORY_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface Notification {
  event: "message" | "open";
  id: string;
  time: number;
  topic: string;
  message: string;
  title?: string;
  tags?: string[];
  priority?: number;
  click?: string;
  actions?: string;
  attach?: string;
  filename?: string;
  delay?: string;
  email?: string;
  call?: string;
  icon?: string;
}

export type PublishInput = Omit<Notification, "event" | "id" | "time" | "topic"> & { message: string };
type RuntimeEnv = Env & { PUBLISH_TOKEN: string };

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
};

function error(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function jsonRpc(id: JsonRpcRequest["id"], result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result }, {
    headers: { "MCP-Protocol-Version": "2025-06-18" }
  });
}

function jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, {
    headers: { "MCP-Protocol-Version": "2025-06-18" }
  });
}

function validTopic(topic: string): boolean {
  return topic.length > 0 && topic.length <= MAX_TOPIC_LENGTH && /^[A-Za-z0-9._-]+$/.test(topic);
}

function bearerValid(request: Request, token: string | undefined): boolean {
  if (!token) return false;
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  const received = new TextEncoder().encode(header.slice(7));
  const expected = new TextEncoder().encode(token);
  if (received.length > MAX_RPC_BYTES || expected.length > MAX_RPC_BYTES) return false;
  let difference = received.length ^ expected.length;
  for (let index = 0; index < MAX_RPC_BYTES; index += 1) {
    difference |= (received[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return difference === 0;
}

function parsePriority(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const priority = typeof value === "number" ? value : Number(value);
  return Number.isInteger(priority) && priority >= 1 && priority <= 5 ? priority : undefined;
}

function headerValue(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value === null || value === "" ? undefined : value;
}

function stringField(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function tagsField(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) {
    if (!value.every((tag) => typeof tag === "string")) throw new Error("Tags must be an array of strings");
    return value as string[];
  }
  if (typeof value === "string") return value.split(",").map((tag) => tag.trim()).filter(Boolean);
  throw new Error("Tags must be an array of strings");
}

function validatePublish(topic: string, input: unknown): PublishInput {
  if (!validTopic(topic)) throw new Error("Invalid topic");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Notification must be an object");
  const value = input as Record<string, unknown>;
  const message = stringField(value.message, "Message");
  if (!message) throw new Error("A non-empty message is required");
  if (value.delay !== undefined && value.delay !== null && value.delay !== "") throw new Error("Delayed delivery is not supported");
  const rawPriority = value.priority;
  const priority = parsePriority(rawPriority);
  if (rawPriority !== undefined && rawPriority !== null && rawPriority !== "" && priority === undefined) throw new Error("Priority must be an integer from 1 to 5");
  const result: PublishInput = {
    message,
    title: stringField(value.title, "Title"),
    tags: tagsField(value.tags),
    priority,
    click: stringField(value.click, "Click"),
    actions: stringField(value.actions, "Actions"),
    attach: stringField(value.attach, "Attach"),
    filename: stringField(value.filename, "Filename"),
    email: stringField(value.email, "Email"),
    call: stringField(value.call, "Call"),
    icon: stringField(value.icon, "Icon")
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_RPC_BYTES) throw new Error("Notification is too large");
  return result;
}

async function parsePublish(request: Request, topic: string): Promise<PublishInput> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].toLowerCase();
  const length = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error("Payload is too large");
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) throw new Error("Payload is too large");
  const text = new TextDecoder().decode(body);
  let value: Record<string, unknown>;
  if (contentType === "application/json") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      value = parsed as Record<string, unknown>;
    } catch {
      throw new Error("Request body must be valid JSON");
    }
  } else {
    value = { message: text };
  }
  const message = typeof value.message === "string" ? value.message : undefined;
  if (!message || new TextEncoder().encode(message).byteLength > MAX_BODY_BYTES) throw new Error("A non-empty message is required");
  const rawPriority = value.priority ?? request.headers.get("Priority");
  const priority = parsePriority(rawPriority);
  if (rawPriority !== undefined && rawPriority !== null && rawPriority !== "" && priority === undefined) throw new Error("Priority must be an integer from 1 to 5");
  const result: Record<string, unknown> = {
    message,
    title: value.title ?? headerValue(request.headers, "Title"),
    tags: tagsField(value.tags ?? request.headers.get("Tags")),
    priority,
    click: value.click ?? headerValue(request.headers, "Click"),
    actions: value.actions ?? headerValue(request.headers, "Actions"),
    attach: value.attach ?? headerValue(request.headers, "Attach"),
    filename: value.filename ?? headerValue(request.headers, "Filename"),
    delay: value.delay ?? headerValue(request.headers, "Delay"),
    email: value.email ?? headerValue(request.headers, "Email"),
    call: value.call ?? headerValue(request.headers, "Call"),
    icon: value.icon ?? headerValue(request.headers, "Icon")
  };
  return validatePublish(topic, result);
}

export class NtfyWorker extends WorkerEntrypoint<RuntimeEnv> {
  async publish(topic: string, notification: PublishInput): Promise<Notification> {
    const input = validatePublish(topic, notification);
    const result = await this.env.TOPIC.getByName(topic).publish(topic, input);
    console.log(JSON.stringify({ event: "publish", topic, id: result.id }));
    return result;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return request.method === "GET" ? Response.json({ status: "ok" }) : error("Method not allowed", 405);
    if (url.pathname === "/mcp") return this.mcp(request);
    const parts = url.pathname.split("/").filter(Boolean);
    const topic = parts[0];
    if (!topic || parts.length > 2 || !validTopic(topic)) return error("Invalid topic or route", 404);
    if (!bearerValid(request, this.env.PUBLISH_TOKEN)) return error("Unauthorized", 401);
    const suffix = parts[1];
    const stub = this.env.TOPIC.getByName(topic);
    if (suffix === "ws") {
      if (request.method !== "GET") return error("Method not allowed", 405);
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error("Expected WebSocket upgrade", 400);
      return stub.fetch(request);
    }
    if (suffix === "json" && request.method === "GET" && url.searchParams.get("poll") === "1") {
       const messages = await stub.poll(parseSince(url.searchParams.get("since")));
      return new Response(messages.map((message) => JSON.stringify(message)).join("\n") + (messages.length ? "\n" : ""), { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
    }
    if (!suffix && (request.method === "POST" || request.method === "PUT")) {
      try {
         return Response.json(await this.publish(topic, await parsePublish(request, topic)));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Invalid request";
        return error(message, message === "Payload is too large" ? 413 : 400);
      }
    }
    return error("Unsupported route", 404);
  }

  private async mcp(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    if (!bearerValid(request, this.env.PUBLISH_TOKEN)) return error("Unauthorized", 401);

    const origin = request.headers.get("Origin");
    if (origin) {
      try {
        if (new URL(origin).hostname !== new URL(request.url).hostname) return error("Forbidden origin", 403);
      } catch {
        return error("Forbidden origin", 403);
      }
    }

    const length = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) return error("Payload is too large", 413);
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return error("Payload is too large", 413);

    let rpc: JsonRpcRequest;
    try {
      rpc = JSON.parse(new TextDecoder().decode(body)) as JsonRpcRequest;
      if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") throw new Error();
    } catch {
      return jsonRpcError(undefined, -32700, "Parse error");
    }

    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "ping") return jsonRpc(rpc.id, {});
    if (rpc.method === "initialize") {
      return jsonRpc(rpc.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "ntfy-cf", version: "1.0.0" },
        instructions: "Publish notifications and read retained topic history."
      });
    }
    if (rpc.method === "tools/list") return jsonRpc(rpc.id, { tools: MCP_TOOLS });
    if (rpc.method !== "tools/call") return jsonRpcError(rpc.id, -32601, "Method not found");

    const params = rpc.params as { name?: unknown; arguments?: unknown } | undefined;
    if (!params || typeof params.name !== "string" || !params.arguments || typeof params.arguments !== "object" || Array.isArray(params.arguments)) {
      return jsonRpcError(rpc.id, -32602, "Invalid tool arguments");
    }

    try {
      const args = params.arguments as Record<string, unknown>;
      if (params.name === "publish_notification") {
        const topic = stringField(args.topic, "Topic");
        if (!topic) throw new Error("Topic is required");
        const notification = await this.publish(topic, validatePublish(topic, args));
        return jsonRpc(rpc.id, toolResult(notification));
      }
      if (params.name === "get_notifications") {
        const topic = stringField(args.topic, "Topic");
        if (!topic || !validTopic(topic)) throw new Error("Invalid topic");
        const since = args.since === undefined ? "all" : stringField(args.since, "Since");
        const notifications = await this.env.TOPIC.getByName(topic).poll(parseSince(since ?? "all"));
        return jsonRpc(rpc.id, toolResult(notifications));
      }
      return jsonRpcError(rpc.id, -32602, "Unknown tool");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Tool call failed";
      return jsonRpc(rpc.id, {
        content: [{ type: "text", text: message }],
        isError: true
      });
    }
  }
}

function toolResult(value: unknown): object {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { result: value }
  };
}

const MCP_TOOLS = [
  {
    name: "publish_notification",
    description: "Publish a notification to an ntfy-cf topic.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["topic", "message"],
      properties: {
        topic: { type: "string", pattern: "^[A-Za-z0-9._-]+$", maxLength: MAX_TOPIC_LENGTH },
        message: { type: "string", minLength: 1 },
        title: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        priority: { type: "integer", minimum: 1, maximum: 5 },
        click: { type: "string" },
        actions: { type: "string" },
        attach: { type: "string" },
        filename: { type: "string" },
        icon: { type: "string" }
      }
    }
  },
  {
    name: "get_notifications",
    description: "Read retained notifications from an ntfy-cf topic.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["topic"],
      properties: {
        topic: { type: "string", pattern: "^[A-Za-z0-9._-]+$", maxLength: MAX_TOPIC_LENGTH },
        since: { type: "string", description: "all, a Unix timestamp, or a message ID" }
      }
    }
  }
] as const;

function parseSince(value: string | null): number | string | undefined {
  if (!value || value === "all") return value === "all" ? "all" : undefined;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export class Topic extends DurableObject<RuntimeEnv> {
  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, time INTEGER NOT NULL, topic TEXT NOT NULL, message TEXT NOT NULL, data TEXT NOT NULL)");
    });
  }

  async publish(topic: string, input: PublishInput): Promise<Notification> {
    const message: Notification = { ...input, event: "message", id: crypto.randomUUID().replaceAll("-", "").slice(0, 16), time: Math.floor(Date.now() / 1000), topic };
    this.ctx.storage.sql.exec("INSERT INTO messages (id, time, topic, message, data) VALUES (?, ?, ?, ?, ?)", message.id, message.time, topic, message.message, JSON.stringify(message));
    this.ctx.storage.sql.exec("DELETE FROM messages WHERE time < ? OR id NOT IN (SELECT id FROM messages ORDER BY time DESC, id DESC LIMIT ?)", message.time - HISTORY_TTL_SECONDS, MAX_HISTORY);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }
    return message;
  }

  async poll(since?: number | string): Promise<Notification[]> {
    let rows: Array<{ data: string }>;
    if (since === "all" || since === undefined) rows = this.ctx.storage.sql.exec<{ data: string }>("SELECT data FROM messages ORDER BY time ASC, rowid ASC").toArray();
    else if (typeof since === "number") rows = this.ctx.storage.sql.exec<{ data: string }>("SELECT data FROM messages WHERE time > ? ORDER BY time ASC, id ASC", since).toArray();
    else rows = this.ctx.storage.sql.exec<{ data: string }>("SELECT data FROM messages WHERE rowid > (SELECT rowid FROM messages WHERE id = ?) ORDER BY time ASC, rowid ASC", since).toArray();
    return rows.map((row) => JSON.parse(row.data) as Notification);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error("Expected WebSocket upgrade", 400);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ event: "open", topic: new URL(request.url).pathname.split("/")[1], time: Math.floor(Date.now() / 1000) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_socket: WebSocket, _message: string | ArrayBuffer): Promise<void> {}
  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    if (code !== 1005) socket.close(code, reason);
  }
  async webSocketError(_socket: WebSocket, error: unknown): Promise<void> { console.error(JSON.stringify({ event: "websocket_error", error: String(error) })); }
}

export default NtfyWorker;
