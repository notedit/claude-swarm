// Shared type definitions for claude-swarm (Cloudflare Sandbox)

import type { Sandbox } from "@cloudflare/sandbox";

export type AgentStatus = "running" | "done" | "error";

// Worker environment bindings (from wrangler.toml)
export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL?: string;
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

// Trace context propagated from Worker → Orchestrator → Agent
export interface TraceContext {
  traceId: string;
  sessionId?: string;
}

// Envelope included in every API response for client-side tracing
export interface ResponseMeta {
  traceId: string;
  durationMs: number;
}
