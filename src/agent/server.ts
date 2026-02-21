// Agent HTTP server — runs inside the Cloudflare Sandbox container.
// Provides an async HTTP interface for multi-turn conversations.
//
// The Worker sends messages which are queued and processed asynchronously.
// Results are retrieved via polling.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { rootLogger, newTraceId } from "../logger.js";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const SESSION_ID = process.env.SESSION_ID ?? "unknown";

// Root logger for this agent process — sessionId is fixed for the lifetime
// of the container; traceId is per-message and set from x-trace-id header.
const agentLog = rootLogger.agent(SESSION_ID);

agentLog.info("agent server starting", { port: PORT });

interface Turn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  traceId?: string;
  durationMs?: number;
}

// In-memory conversation history (persists across turns while sandbox is alive)
const history: Turn[] = [];

// Processing state
let processing = false;
let lastError: string | null = null;
let currentTraceId: string | null = null;

const app = new Hono();

// POST /message — queue a user message for async processing
app.post("/message", async (c) => {
  const { content } = await c.req.json<{ content: string }>();
  const traceId = c.req.header("x-trace-id") ?? newTraceId();
  const log = agentLog.child({ traceId });

  if (!content) {
    log.warn("message rejected: empty content");
    return c.json({ error: "content is required" }, 400);
  }

  if (processing) {
    log.warn("message rejected: already processing");
    return c.json({ error: "already processing a message" }, 409);
  }

  log.info("message received", { historyLength: history.length, contentLength: content.length });

  // Add user message to history
  history.push({
    role: "user",
    content,
    timestamp: new Date().toISOString(),
    traceId,
  });

  // Start async processing
  processing = true;
  lastError = null;
  currentTraceId = traceId;

  processMessage(traceId).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    agentLog.child({ traceId }).error("processMessage uncaught error", { error: msg });
    lastError = msg;
    processing = false;
    currentTraceId = null;
  });

  // Return immediately
  return c.json({
    status: "processing",
    message_index: history.length - 1,
    traceId,
  });
});

// GET /status — check processing status and get latest result
app.get("/status", (c) => {
  if (processing) {
    return c.json({ status: "processing", turns: history.length, traceId: currentTraceId });
  }

  if (lastError) {
    return c.json({
      status: "error",
      error: lastError,
      turns: history.length,
      traceId: currentTraceId,
    });
  }

  // Return the last assistant message if available
  const lastTurn = history[history.length - 1];
  if (lastTurn?.role === "assistant") {
    return c.json({
      status: "done",
      role: "assistant",
      content: lastTurn.content,
      turns: history.length,
      traceId: lastTurn.traceId,
      durationMs: lastTurn.durationMs,
    });
  }

  return c.json({ status: "idle", turns: history.length });
});

// GET /messages — return full conversation history
app.get("/messages", (c) => {
  return c.json({ history, session_id: SESSION_ID });
});

// GET /health — health check
app.get("/health", (c) => {
  return c.json({ status: "ok", turns: history.length, processing, session_id: SESSION_ID });
});

// Start server
serve({ fetch: app.fetch, port: PORT }, () => {
  agentLog.info("agent server ready", { port: PORT });
});

// ── Helpers ──────────────────────────────────────────────────────────────

async function processMessage(traceId: string): Promise<void> {
  const log = agentLog.child({ traceId });
  const prompt = buildPrompt(history);
  const start = Date.now();

  log.info("processMessage start", { historyLength: history.length });

  let result = "";
  let sdkTurns = 0;

  try {
    for await (const message of query({
      prompt,
      options: {
        allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        permissionMode: "bypassPermissions",
        maxTurns: config.maxTurns,
      },
    })) {
      sdkTurns++;
      if ("result" in message) {
        result = message.result as string;
      }
    }
  } catch (err) {
    const durationMs = Date.now() - start;
    log.error("Claude SDK error", {
      error: err instanceof Error ? err.message : String(err),
      durationMs,
      sdkTurns,
    });
    lastError = err instanceof Error ? err.message : String(err);
    processing = false;
    currentTraceId = null;
    return;
  }

  const durationMs = Date.now() - start;
  log.info("processMessage done", { durationMs, sdkTurns, resultLength: result.length });

  // Add assistant response to history with timing metadata
  history.push({
    role: "assistant",
    content: result,
    timestamp: new Date().toISOString(),
    traceId,
    durationMs,
  });

  processing = false;
  currentTraceId = null;
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
