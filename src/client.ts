/**
 * SwarmClient — high-level framework SDK for claude-swarm.
 *
 * Wraps the raw HTTP API into an ergonomic TypeScript client that:
 *   - Manages session lifecycle automatically
 *   - Propagates trace IDs across calls
 *   - Polls for results with configurable timeout and backoff
 *   - Exposes a simple `chat()` method for multi-turn conversations
 *
 * Usage:
 *
 *   const swarm = new SwarmClient({ baseUrl: "https://my-worker.workers.dev" });
 *   const session = await swarm.createSession();
 *
 *   const reply = await session.chat("List all TypeScript files");
 *   console.log(reply);  // "Found 5 files: ..."
 *
 *   await session.destroy();
 */

import type { SessionInfo, ConversationTurn, ResponseMeta } from "./types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface SwarmClientOptions {
  /** Base URL of the deployed Cloudflare Worker */
  baseUrl: string;
  /** Bearer token for Authorization header (optional) */
  apiKey?: string;
  /** How long to wait for the agent to finish processing, in ms (default 120_000) */
  pollTimeoutMs?: number;
  /** Initial poll interval in ms (default 500, doubles up to maxPollIntervalMs) */
  pollIntervalMs?: number;
  /** Max poll interval in ms (default 4_000) */
  maxPollIntervalMs?: number;
}

// ─── API response shapes ──────────────────────────────────────────────────────

interface ApiSessionCreated extends SessionInfo {
  traceId?: string;
}

interface ApiMessageQueued {
  session_id: string;
  status: string;
  message_index: number;
  traceId?: string;
}

interface ApiStatusResponse {
  session_id: string;
  status: "processing" | "done" | "error" | "idle";
  role?: string;
  content?: string;
  error?: string;
  turns?: number;
  traceId?: string;
}

interface ApiHistoryResponse {
  session_id: string;
  history: ConversationTurn[];
  traceId?: string;
}

// ─── SwarmSession ─────────────────────────────────────────────────────────────

/**
 * Represents a single live agent session.
 * Returned by SwarmClient.createSession() or SwarmClient.session().
 */
export class SwarmSession {
  readonly sessionId: string;
  private client: SwarmClient;

  constructor(sessionId: string, client: SwarmClient) {
    this.sessionId = sessionId;
    this.client = client;
  }

  /**
   * Send a message and wait for the agent to finish processing.
   * Returns the assistant's text response.
   */
  async chat(content: string): Promise<string> {
    return this.client.chat(this.sessionId, content);
  }

  /** Get the full conversation history for this session. */
  async history(): Promise<ConversationTurn[]> {
    return this.client.getHistory(this.sessionId);
  }

  /** Get the current session status. */
  async status(): Promise<SessionInfo> {
    return this.client.getSessionStatus(this.sessionId);
  }

  /** Destroy the sandbox and free all resources. */
  async destroy(): Promise<void> {
    return this.client.destroySession(this.sessionId);
  }
}

// ─── SwarmClient ──────────────────────────────────────────────────────────────

export class SwarmClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private pollTimeoutMs: number;
  private pollIntervalMs: number;
  private maxPollIntervalMs: number;

  constructor(opts: SwarmClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    };
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 120_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.maxPollIntervalMs = opts.maxPollIntervalMs ?? 4_000;
  }

  // ── Session management ───────────────────────────────────────────────────

  /**
   * Create a new agent session (spins up a sandbox).
   * Returns a SwarmSession bound to the new session ID.
   */
  async createSession(sessionId?: string): Promise<SwarmSession> {
    const resp = await this.post<ApiSessionCreated>("/sessions", {
      session_id: sessionId,
    });
    return new SwarmSession(resp.session_id, this);
  }

  /**
   * Get a SwarmSession handle for an already-existing session.
   * Does not verify that the session is alive — call session.status() to check.
   */
  session(sessionId: string): SwarmSession {
    return new SwarmSession(sessionId, this);
  }

  /** Destroy a session. */
  async destroySession(sessionId: string): Promise<void> {
    await this.delete(`/sessions/${sessionId}`);
  }

  /** Get session info. */
  async getSessionStatus(sessionId: string): Promise<SessionInfo> {
    return this.get<SessionInfo>(`/sessions/${sessionId}`);
  }

  // ── Messaging ────────────────────────────────────────────────────────────

  /**
   * Send a message and poll until the agent responds.
   * Returns the assistant's final text.
   */
  async chat(sessionId: string, content: string): Promise<string> {
    await this.post<ApiMessageQueued>(`/sessions/${sessionId}/messages`, {
      content,
    });
    return this.pollUntilDone(sessionId);
  }

  /** Get the full conversation history. */
  async getHistory(sessionId: string): Promise<ConversationTurn[]> {
    const resp = await this.get<ApiHistoryResponse>(
      `/sessions/${sessionId}/messages`,
    );
    return resp.history;
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  private async pollUntilDone(sessionId: string): Promise<string> {
    const deadline = Date.now() + this.pollTimeoutMs;
    let interval = this.pollIntervalMs;

    while (Date.now() < deadline) {
      await sleep(interval);
      // exponential backoff
      interval = Math.min(interval * 2, this.maxPollIntervalMs);

      const resp = await this.get<ApiStatusResponse>(
        `/sessions/${sessionId}/status`,
      );

      if (resp.status === "done") {
        return resp.content ?? "";
      }
      if (resp.status === "error") {
        throw new SwarmError(
          `Agent error in session ${sessionId}: ${resp.error}`,
          sessionId,
        );
      }
      // "processing" | "idle" → keep polling
    }

    throw new SwarmError(
      `Timed out waiting for session ${sessionId} after ${this.pollTimeoutMs}ms`,
      sessionId,
    );
  }

  // ── HTTP helpers ─────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers,
    });
    return this.parseResponse<T>(resp);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(resp);
  }

  private async delete(path: string): Promise<void> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.headers,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new SwarmError(`DELETE ${path} failed (${resp.status}): ${text}`);
    }
  }

  private async parseResponse<T>(resp: Response): Promise<T> {
    const text = await resp.text();
    if (!resp.ok) {
      throw new SwarmError(
        `HTTP ${resp.status} from ${resp.url}: ${text}`,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SwarmError(`Invalid JSON response from ${resp.url}: ${text}`);
    }
  }
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class SwarmError extends Error {
  readonly sessionId?: string;

  constructor(message: string, sessionId?: string) {
    super(message);
    this.name = "SwarmError";
    this.sessionId = sessionId;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
