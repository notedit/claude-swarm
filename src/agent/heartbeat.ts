// Agent-side heartbeat reporting
// Runs inside each Fly Machine alongside the agent process

import Redis from "ioredis";
import { config } from "../config";
import type { HeartbeatPayload, AgentStatus } from "../types";

export class HeartbeatReporter {
  private redis: Redis;
  private sessionId: string;
  private machineId: string;
  private startedAt: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(sessionId: string) {
    this.redis = new Redis(config.redisUrl);
    this.sessionId = sessionId;
    this.machineId = process.env.FLY_MACHINE_ID ?? "local";
    this.startedAt = String(Date.now() / 1000);
  }

  private heartbeatKey(): string {
    return `agent:heartbeat:${this.sessionId}`;
  }

  private statusKey(): string {
    return `agent:status:${this.sessionId}`;
  }

  /** Start the periodic heartbeat loop */
  start(): void {
    // Report immediately on start
    this.report("running").catch((err) =>
      console.error("[heartbeat] initial report failed:", err)
    );

    this.timer = setInterval(() => {
      this.report("running").catch((err) =>
        console.error("[heartbeat] report failed:", err)
      );
    }, config.heartbeatInterval * 1000);
  }

  /** Report a single heartbeat to Redis */
  private async report(status: AgentStatus): Promise<void> {
    const payload: HeartbeatPayload = {
      machine_id: this.machineId,
      started_at: this.startedAt,
      status,
    };

    await this.redis.setex(
      this.heartbeatKey(),
      config.heartbeatTtl,
      JSON.stringify(payload)
    );
  }

  /**
   * Signal successful completion.
   * Deletes the heartbeat key and sets status=done so the Reaper or
   * auto_destroy can immediately clean up the Machine.
   */
  async markDone(): Promise<void> {
    this.stop();
    await Promise.all([
      this.redis.del(this.heartbeatKey()),
      this.redis.set(this.statusKey(), "done", "EX", 3600),
    ]);
  }

  /**
   * Signal an error.
   * Deletes the heartbeat key and sets status=error.
   */
  async markError(err: unknown): Promise<void> {
    this.stop();
    const message = err instanceof Error ? err.message : String(err);
    await Promise.all([
      this.redis.del(this.heartbeatKey()),
      this.redis.set(
        this.statusKey(),
        JSON.stringify({ status: "error", message }),
        "EX",
        3600
      ),
    ]);
  }

  /** Stop the interval timer */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Close the Redis connection */
  async close(): Promise<void> {
    this.stop();
    await this.redis.quit();
  }
}
