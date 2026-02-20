// HTTP API server for the Orchestrator
// Exposes session management over HTTP so external clients can trigger agent runs.

import * as http from "http";
import { Orchestrator } from "./orchestrator";

const PORT = parseInt(process.env.PORT ?? "8080", 10);

const orchestrator = new Orchestrator();

// ─── Helpers ────────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ─── Routes ─────────────────────────────────────────────────────────────────

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // Health check
  if (method === "GET" && url === "/health") {
    json(res, 200, { status: "ok" });
    return;
  }

  // POST /sessions — create a new session
  if (method === "POST" && url === "/sessions") {
    const raw = await readBody(req);
    let body: { prompt?: string; session_id?: string };
    try {
      body = JSON.parse(raw);
    } catch {
      json(res, 400, { error: "invalid JSON" });
      return;
    }

    if (!body.prompt) {
      json(res, 400, { error: "prompt is required" });
      return;
    }

    const sessionId = body.session_id ?? `session-${Date.now()}`;
    const session = await orchestrator.getOrCreateSession(sessionId, body.prompt);
    json(res, 201, session);
    return;
  }

  // GET /sessions/:id — get session status
  const statusMatch = url.match(/^\/sessions\/([^/]+)$/);
  if (method === "GET" && statusMatch) {
    const sessionId = statusMatch[1];
    // Return whatever status Redis has (or null if still running)
    const status = await orchestrator.getSessionStatus(sessionId);
    json(res, 200, { session_id: sessionId, status });
    return;
  }

  // 404
  json(res, 404, { error: "not found" });
}

// ─── Server ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error("[server] request error:", err);
    json(res, 500, { error: "internal server error" });
  }
});

orchestrator.start();
server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
});

// Graceful shutdown
const shutdown = async () => {
  console.log("[server] shutting down…");
  server.close();
  await orchestrator.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
