const DEFAULT_URL = "https://ntfy-kyeshimizu.kyeshimizu.workers.dev";

function env(name) {
  return globalThis.process?.env?.[name];
}

function stringOption(options, name, fallback) {
  return typeof options?.[name] === "string" && options[name] ? options[name] : fallback;
}

function errorMessage(error) {
  const message = error?.data?.message;
  if (typeof message === "string" && message) return message;
  if (typeof error?.message === "string" && error.message) return error.message;
  if (typeof error?.name === "string" && error.name) return error.name;
  return "An error occurred. Check the OpenCode session for details.";
}

export function createNotifier(options = {}, fetcher = fetch) {
  const topic = stringOption(options, "topic", env("NTFY_CF_TOPIC"));
  const token = stringOption(options, "token", env("NTFY_CF_TOKEN"));
  const baseUrl = stringOption(options, "url", env("NTFY_CF_URL") || DEFAULT_URL).replace(/\/$/, "");

  if (!topic || !token) return undefined;

  return async (notification) => {
    const response = await fetcher(`${baseUrl}/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`ntfy-cf returned HTTP ${response.status}`);
  };
}

export function createEventHandler({ directory, notify }) {
  const childSessions = new Set();
  const sessionTitles = new Map();
  const project = directory.split(/[\\/]/).filter(Boolean).at(-1) || "OpenCode";

  return async ({ event }) => {
    const properties = event?.properties || event?.data || {};
    const info = properties.info;
    if ((event?.type === "session.created" || event?.type === "session.updated") && info?.id) {
      sessionTitles.set(info.id, info.title);
      if (info.parentID) childSessions.add(info.id);
      return;
    }
    if (event?.type === "session.created" && properties.sessionID) {
      if (properties.parentID) childSessions.add(properties.sessionID);
      return;
    }

    const sessionID = properties.sessionID;
    if ((event?.type === "session.idle" || event?.type === "session.error" || event?.type === "session.execution.failed") && childSessions.has(sessionID)) return;

    const session = sessionTitles.get(sessionID);
    const context = session ? `${project}: ${session}` : project;
    let notification;

    if (event?.type === "session.idle") {
      notification = {
        title: "OpenCode finished",
        message: `${context} is waiting for input.`,
        priority: 3,
        tags: ["opencode", "success"]
      };
    } else if (event?.type === "session.error" || event?.type === "session.execution.failed") {
      notification = {
        title: "OpenCode error",
        message: `${context}: ${errorMessage(properties.error)}`,
        priority: 4,
        tags: ["opencode", "warning"]
      };
    } else if (event?.type === "permission.asked") {
      const permission = typeof properties.permission === "string" ? properties.permission :
        typeof properties.action === "string" ? properties.action : "an action";
      notification = {
        title: "OpenCode needs approval",
        message: `${context} requested permission for ${permission}.`,
        priority: 4,
        tags: ["opencode", "lock"]
      };
    } else {
      return;
    }

    try {
      await notify(notification);
    } catch (error) {
      console.error("[ntfy-cf] notification failed", error);
    }
  };
}

export default {
  id: "ntfy-cf.notifications",
  async setup(ctx) {
    const notify = createNotifier(ctx.options);
    if (!notify) {
      console.warn("[ntfy-cf] notifications disabled; set NTFY_CF_TOPIC and NTFY_CF_TOKEN");
      return;
    }

    if (typeof ctx.event?.subscribe !== "function") {
      console.warn("[ntfy-cf] this OpenCode build does not expose the V2 event subscription API");
      return;
    }

    const directory = stringOption(ctx.options, "directory", globalThis.process?.cwd?.() || "OpenCode");
    const handle = createEventHandler({ directory, notify });
    const controller = new AbortController();
    const task = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        await handle({ event });
      }
    })().catch((error) => {
      if (!controller.signal.aborted) console.error("[ntfy-cf] event subscription failed", error);
    });

    return async () => {
      controller.abort();
      await task;
    };
  }
};
