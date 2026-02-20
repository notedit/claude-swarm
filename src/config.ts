// Configuration parameters for claude-swarm (Cloudflare Sandbox)

export const config = {
  // Agent settings
  maxTurns: 25,           // max Claude SDK turns per message
  maxTurnTimeout: 600,    // seconds - max processing time per message

  // Sandbox settings
  sandboxSleepAfter: "10m",  // auto-sleep after inactivity
} as const;

export type Config = typeof config;
