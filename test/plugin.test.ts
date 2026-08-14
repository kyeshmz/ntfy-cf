import { describe, expect, it, vi } from "vitest";
// The project plugin stays plain JavaScript so OpenCode can load it without a build step.
// @ts-ignore No declaration file is needed for this local plugin.
import plugin, { createEventHandler, createNotifier } from "../.opencode/plugins/ntfy-cf.js";

describe("OpenCode notification plugin", () => {
  it("publishes authenticated JSON notifications", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const notify = createNotifier({ topic: "agent-status", token: "secret", url: "https://ntfy.test/" }, fetcher);

    await notify({ title: "Complete", message: "Finished" });

    expect(fetcher).toHaveBeenCalledWith("https://ntfy.test/agent-status", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      body: JSON.stringify({ title: "Complete", message: "Finished" })
    }));
  });

  it("routes root lifecycle and permission events", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const event = createEventHandler({ directory: "/work/ntfy-cf", notify });

    await event({ event: { type: "session.created", properties: { sessionID: "root", info: { id: "root", title: "Deploy Worker" } } } });
    await event({ event: { type: "session.idle", properties: { sessionID: "root" } } });
    await event({ event: { type: "session.error", properties: { sessionID: "root", error: { data: { message: "Build failed" } } } } });
    await event({ event: { type: "permission.asked", properties: { sessionID: "root", permission: "deploy" } } });

    expect(notify).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: "OpenCode finished", message: "ntfy-cf: Deploy Worker is waiting for input." }));
    expect(notify).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: "OpenCode error", message: "ntfy-cf: Deploy Worker: Build failed" }));
    expect(notify).toHaveBeenNthCalledWith(3, expect.objectContaining({ title: "OpenCode needs approval", message: "ntfy-cf: Deploy Worker requested permission for deploy." }));
  });

  it("suppresses child idle and error notifications", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const event = createEventHandler({ directory: "/work/ntfy-cf", notify });

    await event({ event: { type: "session.created", properties: { sessionID: "child", info: { id: "child", parentID: "root", title: "Research" } } } });
    await event({ event: { type: "session.idle", properties: { sessionID: "child" } } });
    await event({ event: { type: "session.error", properties: { sessionID: "child" } } });

    expect(notify).not.toHaveBeenCalled();
  });

  it("loads without configuration and disables itself", async () => {
    expect(plugin.id).toBe("ntfy-cf.notifications");
    await expect(plugin.setup({ options: { topic: "", token: "" } })).resolves.toBeUndefined();
  });

  it("subscribes to the V2 event stream and aborts it on cleanup", async () => {
    const captured: { signal?: AbortSignal } = {};
    const subscribe = vi.fn(({ signal }) => {
      captured.signal = signal;
      return (async function* () {
        yield { type: "project.updated", data: {} };
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      })();
    });
    const cleanup = await plugin.setup({
      options: { directory: "/work/ntfy-cf", topic: "agent-status", token: "secret" },
      event: { subscribe }
    });

    expect(subscribe).toHaveBeenCalledOnce();
    expect(cleanup).toBeTypeOf("function");
    await cleanup();
    expect(captured.signal?.aborted).toBe(true);
  });
});
