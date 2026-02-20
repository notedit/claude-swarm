// Configuration parameters for claude-swarm
// These values align with the recommended settings in the design document

export const config = {
  // Redis connection URL
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  // Fly.io API settings
  flyApiToken: process.env.FLY_API_TOKEN ?? "",
  flyAppName: process.env.FLY_APP_NAME ?? "claude-agent-app",
  flyAgentImage: process.env.FLY_AGENT_IMAGE ?? "registry.fly.io/claude-agent:latest",

  // Heartbeat settings
  heartbeatTtl: 30,        // seconds - TTL for heartbeat key in Redis
  heartbeatInterval: 10,   // seconds - how often agent reports heartbeat

  // Reaper settings
  reaperInterval: 30,      // seconds - how often reaper scans for zombies

  // Timeout settings
  stopConfigTimeout: 300,  // seconds - Fly Machine stop timeout (5 min)
  maxTurnTimeout: 600,     // seconds - max agent runtime before forced kill (10 min)

  // Agent settings
  maxTurns: 25,            // max turns per agent session

  // Machine sizing
  machine: {
    cpuKind: "shared" as const,
    cpus: 1,
    memoryMb: 512,
  },
} as const;

export type Config = typeof config;
