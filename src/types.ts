// Shared type definitions for claude-swarm (Cloudflare Sandbox)

export type AgentStatus = "running" | "done" | "error";

// Worker environment bindings (from wrangler.toml)
export interface Env {
  Sandbox: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
}

// Stored in /app/inbox/{msgId}.json by the Worker
export interface InboxMessage {
  message_id: string;
  content: string;
  created_at: string;
}

// Stored in /app/outbox/{msgId}.json by the Agent
export interface OutboxMessage {
  message_id: string;
  status: "done" | "error";
  content?: string;
  error?: string;
  created_at: string;
}

// A single conversation turn (stored in history.json)
export interface ConversationTurn {
  message_id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

// Session info returned by the API
export interface SessionInfo {
  session_id: string;
  created_at: string;
  status: AgentStatus;
  message_count: number;
}
