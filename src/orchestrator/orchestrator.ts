// Orchestrator — manages agent sessions via Cloudflare Sandbox SDK.
// Creates sandboxes, dispatches messages, and tracks conversation state
// using file-based IPC (inbox/outbox pattern).

import { getSandbox } from "@cloudflare/sandbox";
import { config } from "../config";
import type {
  Env,
  SessionInfo,
  InboxMessage,
  OutboxMessage,
  ConversationTurn,
} from "../types";

export class Orchestrator {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /** Initialize a new session sandbox */
  async createSession(sessionId: string): Promise<SessionInfo> {
    const sandbox = getSandbox(this.env.Sandbox, sessionId, {
      sleepAfter: config.sandboxSleepAfter,
    });

    // Keep sandbox alive during active session
    await sandbox.setKeepAlive(true);

    // Create inbox/outbox directories
    await sandbox.mkdir(config.paths.inbox, { recursive: true });
    await sandbox.mkdir(config.paths.outbox, { recursive: true });

    // Initialize empty conversation history
    await sandbox.writeFile(config.paths.history, JSON.stringify([]));

    // Set agent environment variables
    await sandbox.setEnvVars({
      ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY ?? "",
      SESSION_ID: sessionId,
    });

    return {
      session_id: sessionId,
      created_at: new Date().toISOString(),
      status: "running",
      message_count: 0,
    };
  }

  /**
   * Send a message to a session.
   * Writes the message to the sandbox inbox and starts a background process
   * to handle the turn. Returns immediately (async processing).
   */
  async sendMessage(
    sessionId: string,
    messageId: string,
    content: string,
  ): Promise<void> {
    const sandbox = getSandbox(this.env.Sandbox, sessionId);

    // Write message to inbox
    const message: InboxMessage = {
      message_id: messageId,
      content,
      created_at: new Date().toISOString(),
    };
    await sandbox.writeFile(
      `${config.paths.inbox}/${messageId}.json`,
      JSON.stringify(message),
    );

    // Start agent process to handle this turn
    await sandbox.startProcess(
      `node /app/dist/agent/handle-turn.js ${messageId}`,
      {
        processId: `turn-${messageId}`,
        timeout: config.maxTurnTimeout * 1000,
      },
    );
  }

  /** Check if a message has been processed (poll outbox) */
  async getMessageStatus(
    sessionId: string,
    messageId: string,
  ): Promise<OutboxMessage | null> {
    const sandbox = getSandbox(this.env.Sandbox, sessionId);

    try {
      const file = await sandbox.readFile(
        `${config.paths.outbox}/${messageId}.json`,
      );
      return JSON.parse(
        typeof file === "string" ? file : file.content,
      ) as OutboxMessage;
    } catch {
      // File doesn't exist yet — still processing
      return null;
    }
  }

  /** Get full conversation history */
  async getHistory(sessionId: string): Promise<ConversationTurn[]> {
    const sandbox = getSandbox(this.env.Sandbox, sessionId);

    try {
      const file = await sandbox.readFile(config.paths.history);
      return JSON.parse(
        typeof file === "string" ? file : file.content,
      ) as ConversationTurn[];
    } catch {
      return [];
    }
  }

  /** Get session status info */
  async getSessionStatus(sessionId: string): Promise<SessionInfo> {
    const sandbox = getSandbox(this.env.Sandbox, sessionId);
    const history = await this.getHistory(sessionId);
    const processes = await sandbox.listProcesses();
    const isProcessing = processes.some((p: { id?: string }) =>
      p.id?.startsWith("turn-"),
    );

    return {
      session_id: sessionId,
      created_at: "",
      status: isProcessing ? "running" : "done",
      message_count: history.filter((t) => t.role === "user").length,
    };
  }

  /** Destroy a session and free all resources */
  async destroySession(sessionId: string): Promise<void> {
    const sandbox = getSandbox(this.env.Sandbox, sessionId);
    await sandbox.destroy();
  }
}
