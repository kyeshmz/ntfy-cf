import { env, evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Notification, PublishInput } from "../src/index";

const token = "test-token";

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return new Request(`https://ntfy.test${path}`, { ...init, headers });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function publish(topic: string, body: BodyInit, headers?: HeadersInit) {
  return SELF.fetch(request(`/${topic}`, { method: "POST", body, headers }));
}

async function mcp(method: string, params?: unknown, id = 1): Promise<Response> {
  return SELF.fetch(request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  }));
}

describe("HTTP Worker runtime", () => {
  it("reports health and enforces auth", async () => {
    const health = await SELF.fetch(new Request("https://ntfy.test/healthz"));
    expect(health.status).toBe(200);
    expect(await json(health)).toEqual({ status: "ok" });

    const missing = await SELF.fetch(new Request("https://ntfy.test/alerts", { method: "POST", body: "nope" }));
    expect(missing.status).toBe(401);
    const wrong = await SELF.fetch(new Request("https://ntfy.test/alerts", { method: "POST", body: "nope", headers: { Authorization: "Bearer wrong" } }));
    expect(wrong.status).toBe(401);
  });

  it("rejects invalid topics, routes, and methods", async () => {
    for (const path of ["/bad%20topic", "/alerts/unknown", "/alerts/json", "/alerts/json?poll=0"]) {
      expect((await SELF.fetch(request(path))).status).toBe(404);
    }
    expect((await SELF.fetch(request("/alerts", { method: "PATCH" }))).status).toBe(404);
    expect((await SELF.fetch(request("/healthz", { method: "POST" }))).status).toBe(405);
    expect((await SELF.fetch(request("/alerts/ws", { method: "POST" }))).status).toBe(405);
    expect((await SELF.fetch(request("/alerts/ws"))).status).toBe(400);
  });

  it("publishes text and JSON with metadata and tags", async () => {
    const textResponse = await publish("text-topic", "hello", {
      Title: "From header",
      Tags: "one, two",
      Priority: "4"
    });
    expect(textResponse.status).toBe(200);
    const text = await json<Notification>(textResponse);
    expect(text).toMatchObject({ message: "hello", title: "From header", tags: ["one", "two"], priority: 4, event: "message", topic: "text-topic" });
    expect(text.id).toMatch(/^[a-f0-9]{16}$/);
    expect(text.time).toBeTypeOf("number");

    const input = { message: "json body", title: "Body title", tags: ["a", "b"], priority: 2, click: "https://example.test" };
    const response = await publish("json-topic", JSON.stringify(input), { "Content-Type": "application/json" });
    expect(response.status).toBe(200);
    expect(await json<Notification>(response)).toMatchObject({ ...input, event: "message", topic: "json-topic" });
  });

  it("rejects malformed, delayed, invalid, and oversized requests", async () => {
    const malformed = await publish("validation", "{", { "Content-Type": "application/json" });
    expect(malformed.status).toBe(400);
    expect((await json<{ error: string }>(malformed)).error).toContain("valid JSON");
    expect((await publish("validation", "", {})).status).toBe(400);
    expect((await publish("validation", JSON.stringify({ message: "x", priority: 6 }), { "Content-Type": "application/json" })).status).toBe(400);
    expect((await publish("validation", JSON.stringify({ message: "x", delay: "10m" }), { "Content-Type": "application/json" })).status).toBe(400);
    expect((await publish("validation", "x".repeat(64 * 1024 + 1))).status).toBe(413);
    expect((await publish("validation", JSON.stringify({ message: "x", title: 1 }), { "Content-Type": "application/json" })).status).toBe(400);
  });

  it("polls all messages, defaults, timestamps, and message IDs", async () => {
    const first = await json<Notification>(await publish("polling", "first"));
    const second = await json<Notification>(await publish("polling", "second"));
    expect(second.id).not.toBe(first.id);

    for (const query of ["?poll=1", "?poll=1&since=all"]) {
      const response = await SELF.fetch(request(`/polling/json${query}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("application/x-ndjson");
      expect((await response.text()).trim().split("\n").map((line) => JSON.parse(line).message)).toEqual(["first", "second"]);
    }
    const afterTime = await SELF.fetch(request(`/polling/json?poll=1&since=${first.time}`));
    expect((await afterTime.text()).trim()).toBe("");
    const afterId = await SELF.fetch(request(`/polling/json?poll=1&since=${first.id}`));
    expect((await afterId.text()).trim().split("\n").map((line) => JSON.parse(line).message)).toEqual(["second"]);
  });

  it("validates and publishes through the entrypoint RPC", async () => {
    const input: PublishInput = { message: "rpc", tags: ["rpc"], priority: 3 };
    const result = await workerExports.default.publish("rpc-topic", input);
    expect(result).toMatchObject({ message: "rpc", tags: ["rpc"], priority: 3, topic: "rpc-topic" });
  });

  it("preserves topic history across Durable Object eviction", async () => {
    const stub = env.TOPIC.getByName("persistent");
    const before = await stub.publish("persistent", { message: "stored" });
    await evictDurableObject(stub);
    const messages = await stub.poll("all");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: before.id, message: "stored" });
  });

  it("opens a WebSocket and delivers published messages", async () => {
    const stub = env.TOPIC.getByName("socket-topic");
    await runInDurableObject(stub, async (instance) => {
      const response = await instance.fetch(new Request("https://ntfy.test/socket-topic/ws", { headers: { Upgrade: "websocket" } }));
      expect(response.status).toBe(101);
      const socket = response.webSocket;
      expect(socket).toBeDefined();
      socket!.accept();
      const open = new Promise<Notification>((resolve) => socket!.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)))));
      expect(await open).toMatchObject({ event: "open", topic: "socket-topic" });
      const message = new Promise<Notification>((resolve) => socket!.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)))));
      await publish("socket-topic", "over websocket");
      expect(await message).toMatchObject({ event: "message", message: "over websocket", topic: "socket-topic" });
      socket!.close();
    });
  });

  it("serves authenticated MCP tools", async () => {
    expect((await SELF.fetch(new Request("https://ntfy.test/mcp", { method: "POST", body: "{}" }))).status).toBe(401);

    const initialized = await json<{ result: { serverInfo: { name: string } } }>(await mcp("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" }
    }));
    expect(initialized.result.serverInfo.name).toBe("ntfy-cf");

    const listed = await json<{ result: { tools: Array<{ name: string }> } }>(await mcp("tools/list"));
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(["publish_notification", "get_notifications"]);

    const published = await json<{ result: { structuredContent: { result: Notification } } }>(await mcp("tools/call", {
      name: "publish_notification",
      arguments: { topic: "mcp-topic", message: "from an agent", tags: ["agent"], priority: 3 }
    }));
    expect(published.result.structuredContent.result).toMatchObject({ topic: "mcp-topic", message: "from an agent" });

    const history = await json<{ result: { structuredContent: { result: Notification[] } } }>(await mcp("tools/call", {
      name: "get_notifications",
      arguments: { topic: "mcp-topic", since: "all" }
    }));
    expect(history.result.structuredContent.result).toHaveLength(1);
  });
});
