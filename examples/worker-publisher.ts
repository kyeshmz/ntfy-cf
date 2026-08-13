import { WorkerEntrypoint } from "cloudflare:workers";

export interface NtfyService {
  publish(
    topic: string,
    notification: {
      message: string;
      title?: string;
      tags?: string[];
      priority?: number;
      click?: string;
      actions?: string;
      attach?: string;
      filename?: string;
      email?: string;
      call?: string;
      icon?: string;
    },
  ): Promise<unknown>;
}

interface Env {
  NTFY: NtfyService;
}

export default class Publisher extends WorkerEntrypoint<Env> {
  async fetch(): Promise<Response> {
    const notification = await this.env.NTFY.publish("alerts", {
      message: "Published from another Cloudflare Worker",
      title: "Internal job",
      tags: ["worker"],
      priority: 3,
    });

    return Response.json(notification);
  }
}
