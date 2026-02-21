// Orchestrator — manages agent sessions via Cloudflare Sandbox SDK.
// Creates sandboxes, starts the agent HTTP server, and communicates
// via sandbox.containerFetch() for async multi-turn conversations.

import { getSandbox } from "@cloudflare/sandbox";
import { config } from "../config.js";
import { rootLogger } from "../logger.js";
import type { Env, SessionInfo, ConversationTurn } from "../types.js";

const AGENT_PORT = 8080;

/**
 * Build a Request targeting the agent's port inside the container.
 * Follows the same pattern as proxyToSandbox in the SDK:
 *   new Request(`http://localhost:${port}${path}`, { method, headers, body, duplex })
 */
function agentRequest(
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Request {
  return new Request(`http://localhost:${AGENT_PORT}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.headers,
    body: init?.body,
    duplex: init?.body ? "half" : undefined,
  } as RequestInit);
}

export class Orchestrator {
  private env: Env;
  private traceId: string;

  constructor(env: Env, traceId: string) {
    this.env = env;
    this.traceId = traceId;
  }

  private log(sessionId?: string) {
    return rootLogger.orchestrator(this.traceId, sessionId);
  }

  /** Initialize a new session: create sandbox and start agent HTTP server */
  async createSession(sessionId: string): Promise<SessionInfo> {
    const log = this.log(sessionId);
    log.info("createSession", { sessionId });

    const sandbox = getSandbox(this.env.Sandbox, sessionId, {
      sleepAfter: config.sandboxSleepAfter,
    });

    await sandbox.setKeepAlive(true);

    const envVars: Record<string, string> = {
      ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY ?? "",
      SESSION_ID: sessionId,
      TRACE_ID: this.traceId,
    };
    if (this.env.ANTHROPIC_BASE_URL) {
      envVars.ANTHROPIC_BASE_URL = this.env.ANTHROPIC_BASE_URL;
    }
    await sandbox.setEnvVars(envVars);

    // Start agent as background process with nohup to survive shell exit
    log.info("starting agent process");
    await sandbox.exec("nohup node /app/dist/agent/server.js > /tmp/agent.log 2>&1 &");

    // Wait for agent to be ready
    const ready = await log.span("waitForAgent", () =>
      this.waitForAgent(sandbox, log),
    );
    if (!ready) {
      log.warn("agent did not become ready within timeout");
    }

    log.info("session created");
    return {
      session_id: sessionId,
      created_at: new Date().toISOString(),
      status: "running",
      message_count: 0,
    };
  }

  private async waitForAgent(
    sandbox: ReturnType<typeof getSandbox>,
    log: ReturnType<typeof rootLogger.orchestrator>,
  ): Promise<boolean> {
    for (let i = 0; i < 10; i++) {
      try {
        const result = await sandbox.exec(
          `curl -sf http://localhost:${AGENT_PORT}/health`,
        );
        if (result.exitCode === 0) {
          log.debug("agent ready", { attempt: i + 1 });
          return true;
        }
      } catch {
        // not ready yet
      }
      log.debug("agent not ready, retrying", { attempt: i + 1 });
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  /** Send a message (async) — returns immediately, processing in background */
  async sendMessage(
    sessionId: string,
    content: string,
  ): Promise<{ status: string; message_index: number }> {
    const log = this.log(sessionId);
    log.info("sendMessage", { contentLength: content.length });

    const sandbox = getSandbox(this.env.Sandbox, sessionId);

    const response = await sandbox.containerFetch(
      agentRequest("/message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-trace-id": this.traceId,
        },
        body: JSON.stringify({ content }),
      }),
      AGENT_PORT,
    );

    if (!response.ok) {
      const err = await response.text();
      log.error("sendMessage failed", { status: response.status, error: err });
      throw new Error(`Agent error (${response.status}): ${err}`);
    }

    const result = (await response.json()) as {
      status: string;
      message_index: number;
    };
    log.info("message queued", { messageIndex: result.message_index });
    return result;
  }

  /** Poll for processing status and result */
  async getStatus(sessionId: string): Promise<{
    status: string;
    role?: string;
    content?: string;
    error?: string;
    turns?: number;
  }> {
    const log = this.log(sessionId);
    const sandbox = getSandbox(this.env.Sandbox, sessionId);

    const response = await sandbox.containerFetch(
      agentRequest("/status"),
      AGENT_PORT,
    );

    if (!response.ok) {
      const err = await response.text();
      log.error("getStatus failed", { status: response.status, error: err });
      throw new Error(`Agent not reachable (${response.status}): ${err}`);
    }

    const result = (await response.json()) as {
      status: string;
      role?: string;
      content?: string;
      error?: string;
      turns?: number;
    };
    log.debug("getStatus", { agentStatus: result.status, turns: result.turns });
    return result;
  }

  /** Get full conversation history from the agent */
  async getHistory(sessionId: string): Promise<ConversationTurn[]> {
    const sandbox = getSandbox(this.env.Sandbox, sessionId);

    const response = await sandbox.containerFetch(
      agentRequest("/messages"),
      AGENT_PORT,
    );

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { history: ConversationTurn[] };
    this.log(sessionId).debug("getHistory", { turns: data.history.length });
    return data.history;
  }

  /** Get session status info */
  async getSessionStatus(sessionId: string): Promise<SessionInfo> {
    const log = this.log(sessionId);
    const sandbox = getSandbox(this.env.Sandbox, sessionId);

    try {
      const response = await sandbox.containerFetch(
        agentRequest("/health"),
        AGENT_PORT,
      );

      const data = (await response.json()) as {
        status: string;
        turns: number;
      };

      log.debug("getSessionStatus", {
        agentStatus: data.status,
        turns: data.turns,
      });

      return {
        session_id: sessionId,
        created_at: "",
        status: data.status === "ok" ? "running" : "error",
        message_count: Math.floor(data.turns / 2),
      };
    } catch (err) {
      log.warn("getSessionStatus unreachable", {
        error: err instanceof Error ? err.message : String(err),
      });
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
    const log = this.log(sessionId);
    log.info("destroySession");
    const sandbox = getSandbox(this.env.Sandbox, sessionId);
    await sandbox.destroy();
    log.info("session destroyed");
  }
}
