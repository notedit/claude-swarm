// Cloudflare Worker entry point for claude-swarm.
// Exports the Sandbox Durable Object class and the fetch handler.
// Routes requests to the Orchestrator, which forwards to sandbox agents
// via sandbox.fetch() for synchronous multi-turn conversations.

import { Sandbox, proxyToSandbox } from "@cloudflare/sandbox";
import { Orchestrator } from "./orchestrator/orchestrator";
import type { Env } from "./types";

// Re-export Sandbox so wrangler registers the Durable Object binding
export { Sandbox };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Required for sandbox preview URLs
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

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

      // POST /sessions/:id/messages — send a message (synchronous via sandbox.fetch)
      const sendMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
      if (request.method === "POST" && sendMatch) {
        const sessionId = sendMatch[1];
        const body = (await request.json()) as { content?: string };
        if (!body.content) {
          return json(400, { error: "content is required" });
        }

        const result = await orchestrator.sendMessage(sessionId, body.content);
        return json(200, {
          session_id: sessionId,
          ...result,
        });
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
      if (request.method === "DELETE" && sessionMatch) {
        const sessionId = sessionMatch![1];
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
