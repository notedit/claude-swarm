// Orchestrator — manages agent sessions via Cloudflare Sandbox SDK.
// Creates sandboxes, starts the agent HTTP server, and forwards
// messages via sandbox.fetch() for multi-turn conversations.

import { getSandbox } from "@cloudflare/sandbox";
import { config } from "../config";
import type { Env, SessionInfo, ConversationTurn } from "../types";

export class Orchestrator {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /** Initialize a new session: create sandbox and start agent HTTP server */
  async createSession(sessionId: string): Promise<SessionInfo> {
    const sandbox = getSandbox(this.env.Sandbox, sessionId, {
      sleepAfter: config.sandboxSleepAfter,
    });

    // Keep sandbox alive during active session
    await sandbox.setKeepAlive(true);

    // Set agent environment variables
    await sandbox.setEnvVars({
      ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY ?? "",
      SESSION_ID: sessionId,
    });

    // Start the agent HTTP server inside the sandbox
    await sandbox.startProcess("node /app/dist/agent/server.js", {
      processId: `agent-${sessionId}`,
    });

    return {
      session_id: sessionId,
      created_at: new Date().toISOString(),
      status: "running",
      message_count: 0,
    };
  }

  /**
   * Send a message to a session's agent via sandbox.fetch().
   * Blocks until the agent returns a response (synchronous multi-turn).
   */
  async sendMessage(
    sessionId: string,
    content: string,
  ): Promise<{ role: string; content: string }> {
    const sandbox = getSandbox(this.env.Sandbox, sessionId);

    const response = await sandbox.fetch(
      new Request("http://localhost/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      }),
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Agent error (${response.status}): ${err}`);
    }

    return (await response.json()) as { role: string; content: string };
  }

  /** Get full conversation history from the agent */
  async getHistory(sessionId: string): Promise<ConversationTurn[]> {
    const sandbox = getSandbox(this.env.Sandbox, sessionId);

    const response = await sandbox.fetch(
      new Request("http://localhost/messages", { method: "GET" }),
    );

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { history: ConversationTurn[] };
    return data.history;
  }

  /** Get session status info */
  async getSessionStatus(sessionId: string): Promise<SessionInfo> {
    const sandbox = getSandbox(this.env.Sandbox, sessionId);

    try {
      const response = await sandbox.fetch(
        new Request("http://localhost/health", { method: "GET" }),
      );
      const data = (await response.json()) as {
        status: string;
        turns: number;
      };

      return {
        session_id: sessionId,
        created_at: "",
        status: data.status === "ok" ? "running" : "error",
        message_count: Math.floor(data.turns / 2), // turns include both user + assistant
      };
    } catch {
      return {
        session_id: sessionId,
        created_at: "",
        status: "error",
        message_count: 0,
      };
    }
  }

  /** Destroy a session and free all resources */
  async destroySession(sessionId: string): Promise<void> {
    const sandbox = getSandbox(this.env.Sandbox, sessionId);
    await sandbox.destroy();
  }
}
