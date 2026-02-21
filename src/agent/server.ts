// Agent HTTP server — runs inside the Cloudflare Sandbox container.
// Provides an async HTTP interface for multi-turn conversations.
//
// The Worker sends messages which are queued and processed asynchronously.
// Results are retrieved via polling.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";

const PORT = parseInt(process.env.PORT ?? "8080", 10);

interface Turn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

// In-memory conversation history (persists across turns while sandbox is alive)
const history: Turn[] = [];

// Processing state
let processing = false;
let lastError: string | null = null;

const app = new Hono();

// POST /message — queue a user message for async processing
app.post("/message", async (c) => {
  const { content } = await c.req.json<{ content: string }>();

  if (!content) {
    return c.json({ error: "content is required" }, 400);
  }

  if (processing) {
    return c.json({ error: "already processing a message" }, 409);
  }

  console.log(`[agent] queuing message (history: ${history.length} turns)`);

  // Add user message to history
  history.push({
    role: "user",
    content,
    timestamp: new Date().toISOString(),
  });

  // Start async processing
  processing = true;
  lastError = null;
  processMessage().catch((err) => {
    console.error("[agent] processing error:", err);
    lastError = err instanceof Error ? err.message : String(err);
    processing = false;
  });

  // Return immediately
  return c.json({
    status: "processing",
    message_index: history.length - 1,
  });
});

// GET /status — check processing status and get latest result
app.get("/status", (c) => {
  if (processing) {
    return c.json({ status: "processing", turns: history.length });
  }

  if (lastError) {
    return c.json({ status: "error", error: lastError, turns: history.length });
  }

  // Return the last assistant message if available
  const lastTurn = history[history.length - 1];
  if (lastTurn?.role === "assistant") {
    return c.json({
      status: "done",
      role: "assistant",
      content: lastTurn.content,
      turns: history.length,
    });
  }

  return c.json({ status: "idle", turns: history.length });
});

// GET /messages — return full conversation history
app.get("/messages", (c) => {
  return c.json({ history });
});

// GET /health — health check
app.get("/health", (c) => {
  return c.json({ status: "ok", turns: history.length, processing });
});

// Start server
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[agent] server listening on port ${PORT}`);
});

// ── Helpers ──────────────────────────────────────────────────────────────

async function processMessage(): Promise<void> {
  const prompt = buildPrompt(history);

  console.log("[agent] calling Claude SDK...");

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

  processing = false;
  console.log(`[agent] done (total turns: ${history.length})`);
}

function buildPrompt(turns: Turn[]): string {
  if (turns.length <= 1) {
    return turns[turns.length - 1].content;
  }

  const previous = turns.slice(0, -1);
  const current = turns[turns.length - 1];

  const historyText = previous
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");

  return `Previous conversation:\n${historyText}\n\nUser: ${current.content}`;
}
