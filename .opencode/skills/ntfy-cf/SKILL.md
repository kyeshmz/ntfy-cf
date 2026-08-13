---
name: ntfy-cf
description: Publish progress, completion, failure, and approval notifications through the ntfy-cf MCP server. Use when the user asks to notify them, when a long-running task finishes, or when an unattended agent needs human attention.
---

# ntfy-cf notifications

Use the `ntfy` MCP server to send concise notifications to a topic chosen by the user.

## Workflow

1. Use an existing topic from the conversation. If none exists, ask for one before publishing sensitive information.
2. Call `publish_notification` with a short `title` and actionable `message`.
3. Use priority `4` for failures or required attention, `3` for completion, and `2` for routine progress.
4. Use tags that identify the task, such as `success`, `warning`, `build`, or `deploy`.
5. Never include credentials, tokens, private file contents, or unnecessary personal data.
6. Use `get_notifications` only when retained topic history is needed.

## Examples

Completion:

```json
{
  "topic": "agent-status",
  "title": "Deployment complete",
  "message": "ntfy-cf deployed and remote smoke tests passed.",
  "priority": 3,
  "tags": ["success", "deploy"]
}
```

Attention required:

```json
{
  "topic": "agent-status",
  "title": "Action required",
  "message": "Cloudflare authentication expired; deployment is paused.",
  "priority": 4,
  "tags": ["warning", "cloudflare"]
}
```

The remote MCP endpoint is `/mcp` and requires `Authorization: Bearer <token>`. In OpenCode, set `NTFY_CF_TOKEN` in the environment; never commit it.
