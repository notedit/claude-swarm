// Agent runner - entry point executed inside each Fly Machine
// Uses the Claude Agent SDK to run an agentic task with built-in tools.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { HeartbeatReporter } from "./heartbeat";
import { config } from "../config";

const SESSION_ID = process.env.SESSION_ID;
const PROMPT = process.env.AGENT_PROMPT;

if (!SESSION_ID) {
  console.error("[runner] SESSION_ID env var is required");
  process.exit(1);
}

if (!PROMPT) {
  console.error("[runner] AGENT_PROMPT env var is required");
  process.exit(1);
}

async function main(): Promise<void> {
  const heartbeat = new HeartbeatReporter(SESSION_ID!);
  heartbeat.start();
  console.log(`[runner] session=${SESSION_ID} started`);

  try {
    const result = await runAgent(PROMPT!);
    console.log(`[runner] session=${SESSION_ID} result: ${result.slice(0, 200)}`);
    await heartbeat.markDone();
    console.log(`[runner] session=${SESSION_ID} done`);
  } catch (err) {
    console.error("[runner] agent error:", err);
    await heartbeat.markError(err);
    process.exit(1);
  } finally {
    await heartbeat.close();
  }
}

/**
 * Run a Claude Agent SDK session with built-in tools.
 * The SDK handles the agentic loop (multi-turn) automatically.
 */
async function runAgent(prompt: string): Promise<string> {
  console.log(`[agent] running prompt: ${prompt}`);

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

  return result;
}

main().catch((err) => {
  console.error("[runner] fatal:", err);
  process.exit(1);
});
