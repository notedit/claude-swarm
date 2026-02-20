// MachineReaper - Orchestrator-side zombie Machine cleanup
// Runs as a background loop; scans Redis for machines with lost heartbeats
// or exceeded timeouts and terminates them via the Fly Machines API.

import Redis from "ioredis";
import { config } from "../config";
import type { FlyMachine, HeartbeatPayload, KillReason } from "../types";

const FLY_API_BASE = "https://api.machines.dev/v1";

export class MachineReaper {
  private redis: Redis;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.redis = new Redis(config.redisUrl);
  }

  /** Start the periodic sweep loop */
  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(
      `[reaper] started (interval=${config.reaperInterval}s, maxTurnTimeout=${config.maxTurnTimeout}s)`
    );
    this.scheduleNext();
  }

  private scheduleNext(): void {
    this.timer = setTimeout(async () => {
      if (!this.running) return;
      try {
        await this.sweep();
      } catch (err) {
        console.error("[reaper] sweep error:", err);
      }
      this.scheduleNext();
    }, config.reaperInterval * 1000);
  }

  /** Stop the sweep loop */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Close Redis connection */
  async close(): Promise<void> {
    this.stop();
    await this.redis.quit();
  }

  /** Scan all running Machines and kill those that are zombies or timed out */
  async sweep(): Promise<void> {
    const machines = await this.listRunningMachines();
    console.log(`[reaper] sweep: found ${machines.length} running machines`);

    await Promise.all(
      machines.map((machine) => this.evaluateMachine(machine))
    );
  }

  private async evaluateMachine(machine: FlyMachine): Promise<void> {
    // Machine name format: "agent-session-<sessionId>"
    const prefix = "agent-session-";
    if (!machine.name.startsWith(prefix)) return;

    const sessionId = machine.name.slice(prefix.length);
    const [rawHeartbeat, rawStatus] = await Promise.all([
      this.redis.get(`agent:heartbeat:${sessionId}`),
      this.redis.get(`agent:status:${sessionId}`),
    ]);

    let shouldKill = false;
    let reason: KillReason = "heartbeat_lost";

    if (rawStatus === "done") {
      // Agent finished but auto_destroy hasn't fired yet
      shouldKill = true;
      reason = "task_done";
    } else if (rawHeartbeat === null) {
      // No heartbeat: process crashed or hung before first report
      shouldKill = true;
      reason = "heartbeat_lost";
    } else {
      // Check wall-clock runtime
      const hb: HeartbeatPayload = JSON.parse(rawHeartbeat);
      const elapsed = Date.now() / 1000 - parseFloat(hb.started_at);
      if (elapsed > config.maxTurnTimeout) {
        shouldKill = true;
        reason = "timeout";
      }
    }

    if (shouldKill) {
      await this.killMachine(machine.id, sessionId, reason);
    }
  }

  private async killMachine(
    machineId: string,
    sessionId: string,
    reason: KillReason
  ): Promise<void> {
    console.log(`[reaper] killing machine=${machineId} session=${sessionId} reason=${reason}`);

    try {
      // Stop the machine; auto_destroy=true will then destroy it automatically
      const resp = await fetch(
        `${FLY_API_BASE}/apps/${config.flyAppName}/machines/${machineId}/stop`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.flyApiToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!resp.ok) {
        console.error(
          `[reaper] stop failed for machine=${machineId}: ${resp.status} ${await resp.text()}`
        );
      }
    } catch (err) {
      console.error(`[reaper] stop request error for machine=${machineId}:`, err);
    }

    // Always clean up Redis state, even if the API call failed
    await this.redis.del(
      `agent:heartbeat:${sessionId}`,
      `agent:status:${sessionId}`,
      `agent:machine:${sessionId}`
    );
  }

  private async listRunningMachines(): Promise<FlyMachine[]> {
    const resp = await fetch(
      `${FLY_API_BASE}/apps/${config.flyAppName}/machines`,
      {
        headers: {
          Authorization: `Bearer ${config.flyApiToken}`,
        },
      }
    );

    if (!resp.ok) {
      throw new Error(
        `Failed to list machines: ${resp.status} ${await resp.text()}`
      );
    }

    const machines = (await resp.json()) as FlyMachine[];
    return machines.filter(
      (m) => m.state === "started" || m.state === "starting"
    );
  }
}
