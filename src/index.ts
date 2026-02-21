// Cloudflare Worker entry point for claude-swarm.
// Exports the Sandbox Durable Object class and the fetch handler.
// Routes requests to the Orchestrator, which manages sandbox agents
// via sandbox.exec(curl) for async multi-turn conversations.

import { Sandbox, proxyToSandbox, getSandbox } from "@cloudflare/sandbox";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import type { Env } from "./types.js";

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

      // POST /sessions/:id/messages — send a message (async, returns immediately)
      const sendMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
      if (request.method === "POST" && sendMatch) {
        const sessionId = sendMatch[1];
        const body = (await request.json()) as { content?: string };
        if (!body.content) {
          return json(400, { error: "content is required" });
        }

        const result = await orchestrator.sendMessage(sessionId, body.content);
        return json(202, {
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

      // GET /sessions/:id/status — poll for processing status
      const statusMatch = url.pathname.match(
        /^\/sessions\/([^/]+)\/status$/,
      );
      if (request.method === "GET" && statusMatch) {
        const sessionId = statusMatch[1];
        const status = await orchestrator.getStatus(sessionId);
        return json(200, { session_id: sessionId, ...status });
      }

      // GET /sessions/:id — session info
      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (request.method === "GET" && sessionMatch) {
        const sessionId = sessionMatch[1];
        const info = await orchestrator.getSessionStatus(sessionId);
        return json(200, info);
      }

      // GET /sessions/:id/debug — debug sandbox state
      const debugMatch = url.pathname.match(/^\/sessions\/([^/]+)\/debug$/);
      if (request.method === "GET" && debugMatch) {
        const sessionId = debugMatch[1];
        const sandbox = getSandbox(env.Sandbox, sessionId);
        const processes = await sandbox.listProcesses();
        const procInfo = [];
        for (const p of processes) {
          const logs = await sandbox.getProcessLogs(p.id);
          procInfo.push({ id: p.id, status: p.status, command: p.command, logs });
        }
        return json(200, { processes: procInfo });
      }

      // POST /sessions/:id/exec — run command in sandbox
      const execMatch = url.pathname.match(/^\/sessions\/([^/]+)\/exec$/);
      if (request.method === "POST" && execMatch) {
        const sessionId = execMatch[1];
        const body = (await request.json()) as { command?: string };
        if (!body.command) {
          return json(400, { error: "command is required" });
        }
        const sandbox = getSandbox(env.Sandbox, sessionId);
        const result = await sandbox.exec(body.command);
        return json(200, result);
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
