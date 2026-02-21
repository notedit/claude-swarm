// Agent runner — simplified one-shot entry point for the Cloudflare Sandbox.
// For multi-turn conversations, use handle-turn.ts instead.
//
// Reads SESSION_ID and AGENT_PROMPT from environment variables,
// runs a single Claude Agent SDK session, and writes the result to a file.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync } from "fs";
import { config } from "../config.js";

const SESSION_ID = process.env.SESSION_ID;
const PROMPT = process.env.AGENT_PROMPT;

if (!SESSION_ID || !PROMPT) {
  console.error("[runner] SESSION_ID and AGENT_PROMPT env vars required");
  process.exit(1);
}

async function main(): Promise<void> {
  console.log(`[runner] session=${SESSION_ID} started`);

  let result = "";
  for await (const message of query({
    prompt: PROMPT!,
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

  console.log(`[runner] session=${SESSION_ID} done`);
  writeFileSync("/app/result.json", JSON.stringify({ status: "done", result }));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[runner] fatal:", err);
  writeFileSync("/app/result.json", JSON.stringify({ status: "error", error: msg }));
  process.exit(1);
});
