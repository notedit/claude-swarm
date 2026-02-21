// Cloudflare Worker entry point for claude-swarm.
// Exports the Sandbox Durable Object class and the fetch handler.
// Routes requests to the Orchestrator, which manages sandbox agents
// via sandbox.exec(curl) for async multi-turn conversations.

import { Sandbox, proxyToSandbox, getSandbox } from "@cloudflare/sandbox";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { rootLogger, newTraceId } from "./logger.js";
import type { Env } from "./types.js";

// Re-export Sandbox so wrangler registers the Durable Object binding
export { Sandbox };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Required for sandbox preview URLs
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    const url = new URL(request.url);
    const start = Date.now();

    // Generate a trace ID for this request (or pick up one from the caller)
    const traceId = request.headers.get("x-trace-id") ?? newTraceId();
    const log = rootLogger.worker(traceId);

    log.info("request", {
      method: request.method,
      path: url.pathname,
    });

    const orchestrator = new Orchestrator(env, traceId);

    try {
      // GET /health
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonWithMeta(200, { status: "ok" }, traceId, start);
      }

      // POST /sessions — create a new session
      if (request.method === "POST" && url.pathname === "/sessions") {
        const body = (await request.json()) as { session_id?: string };
        const sessionId = body.session_id ?? `session-${Date.now()}`;
        const sessionLog = log.child({ sessionId });
        const session = await sessionLog.span("createSession", () =>
          orchestrator.createSession(sessionId),
        );
        return jsonWithMeta(201, session, traceId, start);
      }

      // POST /sessions/:id/messages — send a message (async, returns immediately)
      const sendMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
      if (request.method === "POST" && sendMatch) {
        const sessionId = sendMatch[1];
        const sessionLog = log.child({ sessionId });
        const body = (await request.json()) as { content?: string };
        if (!body.content) {
          return jsonWithMeta(400, { error: "content is required" }, traceId, start);
        }
        const result = await sessionLog.span("sendMessage", () =>
          orchestrator.sendMessage(sessionId, body.content!),
        );
        return jsonWithMeta(202, { session_id: sessionId, ...result }, traceId, start);
      }

      // GET /sessions/:id/messages — get full conversation history
      const historyMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
      if (request.method === "GET" && historyMatch) {
        const sessionId = historyMatch[1];
        const history = await orchestrator.getHistory(sessionId);
        return jsonWithMeta(200, { session_id: sessionId, history }, traceId, start);
      }

      // GET /sessions/:id/status — poll for processing status
      const statusMatch = url.pathname.match(/^\/sessions\/([^/]+)\/status$/);
      if (request.method === "GET" && statusMatch) {
        const sessionId = statusMatch[1];
        const status = await orchestrator.getStatus(sessionId);
        return jsonWithMeta(200, { session_id: sessionId, ...status }, traceId, start);
      }

      // GET /sessions/:id — session info
      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (request.method === "GET" && sessionMatch) {
        const sessionId = sessionMatch[1];
        const info = await orchestrator.getSessionStatus(sessionId);
        return jsonWithMeta(200, info, traceId, start);
      }

      // GET /sessions/:id/debug — debug sandbox state
      const debugMatch = url.pathname.match(/^\/sessions\/([^/]+)\/debug$/);
      if (request.method === "GET" && debugMatch) {
        const sessionId = debugMatch[1];
        const sessionLog = log.child({ sessionId });
        sessionLog.info("debug requested");
        const sandbox = getSandbox(env.Sandbox, sessionId);
        const processes = await sandbox.listProcesses();
        const procInfo = [];
        for (const p of processes) {
          const logs = await sandbox.getProcessLogs(p.id);
          procInfo.push({ id: p.id, status: p.status, command: p.command, logs });
        }
        return jsonWithMeta(200, { processes: procInfo }, traceId, start);
      }

      // POST /sessions/:id/exec — run command in sandbox
      const execMatch = url.pathname.match(/^\/sessions\/([^/]+)\/exec$/);
      if (request.method === "POST" && execMatch) {
        const sessionId = execMatch[1];
        const body = (await request.json()) as { command?: string };
        if (!body.command) {
          return jsonWithMeta(400, { error: "command is required" }, traceId, start);
        }
        log.child({ sessionId }).info("exec", { command: body.command });
        const sandbox = getSandbox(env.Sandbox, sessionId);
        const result = await sandbox.exec(body.command);
        return jsonWithMeta(200, result, traceId, start);
      }

      // DELETE /sessions/:id — destroy session
      if (request.method === "DELETE" && sessionMatch) {
        const sessionId = sessionMatch![1];
        const sessionLog = log.child({ sessionId });
        await sessionLog.span("destroySession", () =>
          orchestrator.destroySession(sessionId),
        );
        return jsonWithMeta(200, { session_id: sessionId, destroyed: true }, traceId, start);
      }

      return jsonWithMeta(404, { error: "not found" }, traceId, start);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("unhandled error", { error: message, durationMs: Date.now() - start });
      return jsonWithMeta(500, { error: message }, traceId, start);
    }
  },
};

function jsonWithMeta(
  status: number,
  body: unknown,
  traceId: string,
  startMs: number,
): Response {
  const payload = {
    ...(typeof body === "object" && body !== null ? body : { data: body }),
    _meta: { traceId, durationMs: Date.now() - startMs },
  };
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "x-trace-id": traceId,
    },
  });
}
