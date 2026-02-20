// Cloudflare Worker entry point for claude-swarm.
// Exports the Sandbox Durable Object class and the fetch handler.

import { Sandbox } from "@cloudflare/sandbox";
import { Orchestrator } from "./orchestrator/orchestrator";
import type { Env } from "./types";

// Re-export Sandbox so wrangler registers the Durable Object binding
export { Sandbox };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const orchestrator = new Orchestrator(env);

    try {
      // GET /health
      if (request.method === "GET" && url.pathname === "/health") {
        return json(200, { status: "ok" });
      }

      // POST /sessions — create a new session
      if (request.method === "POST" && url.pathname === "/sessions") {
        const body = (await request.json()) as { session_id?: string };
        const sessionId = body.session_id ?? `session-${Date.now()}`;
        const session = await orchestrator.createSession(sessionId);
        return json(201, session);
      }

      // POST /sessions/:id/messages — send a message (async)
      const sendMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
      if (request.method === "POST" && sendMatch) {
        const sessionId = sendMatch[1];
        const body = (await request.json()) as { content?: string };
        if (!body.content) {
          return json(400, { error: "content is required" });
        }

        const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await orchestrator.sendMessage(sessionId, messageId, body.content);
        return json(202, {
          message_id: messageId,
          status: "processing",
        });
      }

      // GET /sessions/:id/messages/:msgId — poll for a specific message result
      const pollMatch = url.pathname.match(
        /^\/sessions\/([^/]+)\/messages\/([^/]+)$/,
      );
      if (request.method === "GET" && pollMatch) {
        const [, sessionId, messageId] = pollMatch;
        const result = await orchestrator.getMessageStatus(
          sessionId,
          messageId,
        );
        if (result) {
          return json(200, result);
        }
        return json(202, { message_id: messageId, status: "processing" });
      }

      // GET /sessions/:id/messages — get full conversation history
      const historyMatch = url.pathname.match(
        /^\/sessions\/([^/]+)\/messages$/,
      );
      if (request.method === "GET" && historyMatch) {
        const sessionId = historyMatch[1];
        const history = await orchestrator.getHistory(sessionId);
        return json(200, { session_id: sessionId, history });
      }

      // GET /sessions/:id — session info
      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (request.method === "GET" && sessionMatch) {
        const sessionId = sessionMatch[1];
        const info = await orchestrator.getSessionStatus(sessionId);
        return json(200, info);
      }

      // DELETE /sessions/:id — destroy session
      const deleteMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (request.method === "DELETE" && deleteMatch) {
        const sessionId = deleteMatch[1];
        await orchestrator.destroySession(sessionId);
        return json(200, { session_id: sessionId, destroyed: true });
      }

      return json(404, { error: "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[worker] error:", message);
      return json(500, { error: message });
    }
  },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
