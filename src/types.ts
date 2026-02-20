// Shared type definitions for claude-swarm (Cloudflare Sandbox)

export type AgentStatus = "running" | "done" | "error";

// Worker environment bindings (from wrangler.toml)
export interface Env {
  Sandbox: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
}

// A single conversation turn (maintained in agent memory)
export interface ConversationTurn {
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
