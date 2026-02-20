// Agent HTTP server — runs inside the Cloudflare Sandbox container.
// Provides a persistent HTTP interface for multi-turn conversations.
//
// The Worker forwards requests via sandbox.fetch() to this server.
// Conversation history is maintained in memory across turns.

import { createServer, IncomingMessage, ServerResponse } from "http";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config";

const PORT = parseInt(process.env.PORT ?? "8080", 10);

interface Turn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

// In-memory conversation history (persists across turns while sandbox is alive)
const history: Turn[] = [];

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    // POST /message — process a user message
    if (req.method === "POST" && req.url === "/message") {
      const body = await readBody(req);
      const { content } = JSON.parse(body) as { content: string };

      if (!content) {
        respond(res, 400, { error: "content is required" });
        return;
      }

      console.log(`[agent] processing message (history: ${history.length} turns)`);

      // Add user message to history
      history.push({
        role: "user",
        content,
        timestamp: new Date().toISOString(),
      });

      // Build prompt with conversation context
      const prompt = buildPrompt(history);

      // Call Claude Agent SDK
      let result = "";
      for await (const message of query({
        prompt,
        options: {
          allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
          permissionMode: "bypassPermissions",
          maxTurns: config.maxTurns,
        },
      })) {
        if ("result" in message) {
          result = message.result as string;
        }
      }

      // Add assistant response to history
      history.push({
        role: "assistant",
        content: result,
        timestamp: new Date().toISOString(),
      });

      console.log(`[agent] done (total turns: ${history.length})`);
      respond(res, 200, { role: "assistant", content: result });
      return;
    }

    // GET /messages — return full conversation history
    if (req.method === "GET" && req.url === "/messages") {
      respond(res, 200, { history });
      return;
    }

    // GET /health — health check
    if (req.method === "GET" && req.url === "/health") {
      respond(res, 200, { status: "ok", turns: history.length });
      return;
    }

    respond(res, 404, { error: "not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[agent] error:", message);
    respond(res, 500, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`[agent] server listening on port ${PORT}`);
});

// ── Helpers ──────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function buildPrompt(turns: Turn[]): string {
  if (turns.length <= 1) {
    // First message, no history context needed
    return turns[turns.length - 1].content;
  }

  // Include all previous turns as context, last user message is the current prompt
  const previous = turns.slice(0, -1);
  const current = turns[turns.length - 1];

  const historyText = previous
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");

  return `Previous conversation:\n${historyText}\n\nUser: ${current.content}`;
}
