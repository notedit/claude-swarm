// Configuration parameters for claude-swarm (Cloudflare Sandbox)

export const config = {
  // Agent settings
  maxTurns: 25,           // max Claude SDK turns per message
  maxTurnTimeout: 600,    // seconds - max processing time per message

  // Sandbox settings
  sandboxSleepAfter: "10m",  // auto-sleep after inactivity

  // File paths inside the sandbox container
  paths: {
    inbox: "/app/inbox",
    outbox: "/app/outbox",
    history: "/app/history.json",
  },
} as const;

export type Config = typeof config;
