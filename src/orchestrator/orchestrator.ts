// Orchestrator - manages Agent sessions and Fly Machine lifecycle
// Entry point for the orchestrator process.

import Redis from "ioredis";
import { config } from "../config";
import { MachineReaper } from "./reaper";
import type {
  CreateMachineRequest,
  FlyMachine,
  SessionInfo,
} from "../types";

const FLY_API_BASE = "https://api.machines.dev/v1";

export class Orchestrator {
  private redis: Redis;
  private reaper: MachineReaper;

  constructor() {
    this.redis = new Redis(config.redisUrl);
    this.reaper = new MachineReaper();
  }

  /** Start the orchestrator and its background reaper */
  start(): void {
    this.reaper.start();
    console.log("[orchestrator] started");
  }

  /** Gracefully shut down */
  async close(): Promise<void> {
    await this.reaper.close();
    await this.redis.quit();
    console.log("[orchestrator] stopped");
  }

  /**
   * Get or create a session for a given sessionId.
   *
   * - If a Machine is already running for this session, returns its info.
   * - Otherwise, creates a new Fly Machine and stores the mapping in Redis.
   */
  async getOrCreateSession(
    sessionId: string,
    prompt: string
  ): Promise<SessionInfo> {
    // Check for an existing machine mapping
    const existing = await this.redis.get(`agent:machine:${sessionId}`);
    if (existing !== null) {
      const info: SessionInfo = JSON.parse(existing);
      console.log(
        `[orchestrator] session=${sessionId} already has machine=${info.machine_id}`
      );
      return info;
    }

    // Create a new Machine for this session
    const machine = await this.createMachine(sessionId, prompt);
    const info: SessionInfo = {
      session_id: sessionId,
      machine_id: machine.id,
      created_at: new Date().toISOString(),
    };

    // Store session → machine mapping; expire after max timeout + buffer
    await this.redis.set(
      `agent:machine:${sessionId}`,
      JSON.stringify(info),
      "EX",
      config.maxTurnTimeout + 300
    );

    console.log(
      `[orchestrator] session=${sessionId} created machine=${machine.id}`
    );
    return info;
  }

  /**
   * Create a new Fly Machine configured for a single-use agent run.
   * The machine will auto-stop after inactivity and auto-destroy on stop.
   */
  private async createMachine(
    sessionId: string,
    prompt: string
  ): Promise<FlyMachine> {
    const body: CreateMachineRequest = {
      name: `agent-session-${sessionId}`,
      config: {
        image: config.flyAgentImage,
        auto_destroy: true,
        stop_config: {
          timeout: config.stopConfigTimeout,
          signal: "SIGTERM",
        },
        restart: {
          policy: "no",
        },
        guest: {
          cpu_kind: config.machine.cpuKind,
          cpus: config.machine.cpus,
          memory_mb: config.machine.memoryMb,
        },
        env: {
          SESSION_ID: sessionId,
          AGENT_PROMPT: prompt,
          REDIS_URL: config.redisUrl,
          STARTED_AT: String(Date.now() / 1000),
        },
      },
    };

    const resp = await fetch(
      `${FLY_API_BASE}/apps/${config.flyAppName}/machines`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.flyApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      throw new Error(
        `Failed to create machine for session=${sessionId}: ${resp.status} ${await resp.text()}`
      );
    }

    const machine = (await resp.json()) as FlyMachine;
    return machine;
  }

  /**
   * Wait for a session to finish (status = done or error).
   * Polls Redis until resolved or the timeout is reached.
   */
  async waitForSession(
    sessionId: string,
    timeoutMs = config.maxTurnTimeout * 1000
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const pollInterval = 2000; // 2s

    while (Date.now() < deadline) {
      const status = await this.redis.get(`agent:status:${sessionId}`);
      if (status !== null) {
        return status;
      }
      await sleep(pollInterval);
    }

    throw new Error(`session=${sessionId} timed out after ${timeoutMs}ms`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const orchestrator = new Orchestrator();
  orchestrator.start();

  // Graceful shutdown on SIGTERM / SIGINT
  const shutdown = async () => {
    console.log("[orchestrator] shutting down…");
    await orchestrator.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Example: dispatch a single agent session
  const sessionId = process.env.SESSION_ID ?? `test-${Date.now()}`;
  const prompt = process.env.AGENT_PROMPT ?? "Hello, Claude!";

  const session = await orchestrator.getOrCreateSession(sessionId, prompt);
  console.log("[orchestrator] dispatched:", session);

  const status = await orchestrator.waitForSession(sessionId);
  console.log(`[orchestrator] session=${sessionId} finished with status:`, status);

  await orchestrator.close();
}

main().catch((err) => {
  console.error("[orchestrator] fatal:", err);
  process.exit(1);
});
