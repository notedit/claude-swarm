// Per-message turn handler — runs inside the Cloudflare Sandbox container.
// Invoked as: node /app/dist/agent/handle-turn.js <messageId>
//
// Each invocation:
//   1. Reads the message from /app/inbox/{msgId}.json
//   2. Loads conversation history from /app/history.json
//   3. Calls Claude Agent SDK with full conversation context
//   4. Writes response to /app/outbox/{msgId}.json
//   5. Updates conversation history

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { config } from "../config";

const MESSAGE_ID = process.argv[2];
if (!MESSAGE_ID) {
  console.error("[handle-turn] message ID argument required");
  process.exit(1);
}

const INBOX_PATH = `${config.paths.inbox}/${MESSAGE_ID}.json`;
const OUTBOX_PATH = `${config.paths.outbox}/${MESSAGE_ID}.json`;
const HISTORY_PATH = config.paths.history;

interface Turn {
  role: "user" | "assistant";
  content: string;
  message_id: string;
  timestamp: string;
}

async function main(): Promise<void> {
  // 1. Read incoming message
  const inboxRaw = readFileSync(INBOX_PATH, "utf-8");
  const inbox = JSON.parse(inboxRaw) as { message_id: string; content: string };

  // 2. Load conversation history
  let history: Turn[] = [];
  if (existsSync(HISTORY_PATH)) {
    try {
      history = JSON.parse(readFileSync(HISTORY_PATH, "utf-8"));
    } catch {
      history = [];
    }
  }

  // 3. Build prompt with conversation context
  const prompt = buildPrompt(history, inbox.content);

  // 4. Call Claude Agent SDK
  console.log(`[handle-turn] processing message=${MESSAGE_ID}`);
  let result = "";
  try {
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
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[handle-turn] error:", errorMsg);

    writeOutbox(MESSAGE_ID, "error", undefined, errorMsg);

    // Still record the failed turn in history
    const now = new Date().toISOString();
    history.push({ role: "user", content: inbox.content, message_id: MESSAGE_ID, timestamp: now });
    history.push({ role: "assistant", content: `[Error] ${errorMsg}`, message_id: MESSAGE_ID, timestamp: now });
    writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));

    process.exit(1);
  }

  // 5. Write response to outbox
  writeOutbox(MESSAGE_ID, "done", result);

  // 6. Update conversation history
  const now = new Date().toISOString();
  history.push({ role: "user", content: inbox.content, message_id: MESSAGE_ID, timestamp: now });
  history.push({ role: "assistant", content: result, message_id: MESSAGE_ID, timestamp: now });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));

  console.log(`[handle-turn] done message=${MESSAGE_ID}`);
}

function writeOutbox(
  messageId: string,
  status: "done" | "error",
  content?: string,
  error?: string,
): void {
  writeFileSync(
    OUTBOX_PATH,
    JSON.stringify({
      message_id: messageId,
      status,
      ...(content !== undefined && { content }),
      ...(error !== undefined && { error }),
      created_at: new Date().toISOString(),
    }),
  );
}

/** Build a context-aware prompt including conversation history */
function buildPrompt(history: Turn[], newMessage: string): string {
  if (history.length === 0) {
    return newMessage;
  }

  const historyText = history
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");

  return `Previous conversation:\n${historyText}\n\nUser: ${newMessage}`;
}

main().catch((err) => {
  console.error("[handle-turn] fatal:", err);
  process.exit(1);
});
