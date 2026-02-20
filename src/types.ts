// Shared type definitions for claude-swarm

export interface HeartbeatPayload {
  machine_id: string;
  started_at: string; // Unix timestamp as string
  status: "running" | "done" | "error";
}

export type AgentStatus = "running" | "done" | "error";

export type KillReason = "task_done" | "heartbeat_lost" | "timeout";

export interface FlyMachine {
  id: string;
  name: string;
  state:
    | "created"
    | "starting"
    | "started"
    | "stopping"
    | "stopped"
    | "replacing"
    | "destroying"
    | "destroyed";
  region: string;
  instance_id: string;
  private_ip: string;
  config: FlyMachineConfig;
  image_ref?: {
    registry: string;
    repository: string;
    tag: string;
    digest: string;
  };
  created_at: string;
  updated_at: string;
}

export interface FlyMachineConfig {
  image: string;
  auto_destroy?: boolean;
  stop_config?: {
    timeout: number;
    signal: string;
  };
  restart?: {
    policy: "no" | "always" | "on-failure";
  };
  guest?: {
    cpu_kind: "shared" | "performance";
    cpus: number;
    memory_mb: number;
  };
  env?: Record<string, string>;
}

export interface CreateMachineRequest {
  name: string;
  config: FlyMachineConfig;
}

export interface SessionInfo {
  session_id: string;
  machine_id: string;
  created_at: string;
}
