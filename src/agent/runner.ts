// Agent runner - entry point executed inside each Fly Machine
// Wires together the heartbeat reporter and the Claude SDK client

import { HeartbeatReporter } from "./heartbeat";

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
    await runAgent(PROMPT!);
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
 * Placeholder for the actual Claude SDK invocation.
 * Replace this with your ClaudeSDKClient calls.
 */
async function runAgent(prompt: string): Promise<void> {
  // TODO: wire in the Claude SDK client here, e.g.:
  //
  //   import { ClaudeClient } from "@anthropic-ai/sdk";
  //   const client = new ClaudeClient({ apiKey: process.env.ANTHROPIC_API_KEY });
  //   const stream = client.messages.stream({ model: "claude-opus-4-6", ... });
  //   for await (const chunk of stream) { ... }

  console.log(`[agent] running prompt: ${prompt}`);

  // Simulate work so the heartbeat fires at least once during tests
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
}

main().catch((err) => {
  console.error("[runner] fatal:", err);
  process.exit(1);
});
