# Fly.io Deployment Example / Fly.io 部署示例

Complete deployment demo for running claude-swarm on [Fly.io](https://fly.io).

在 [Fly.io](https://fly.io) 上运行 claude-swarm 的完整部署示例。

---

## Architecture / 架构

```
Client (curl / app)
    │
    ▼  HTTP POST /sessions
Orchestrator (Fly App, persistent)
    ├── Redis: session exists? ──yes──► return existing session
    │
    └──no──► Fly Machines API: create ephemeral Machine
                  │
                  ▼
            Agent Machine (Fly Machine, short-lived)
                  ├── HeartbeatReporter → Redis (every 10s)
                  └── Claude Agent SDK
                        ├── Built-in tools (Read, Write, Bash, Glob, Grep, Edit)
                        ├── Multi-turn agentic loop
                        └── Task execution
                              │
                      ┌───────┴────────┐
                 Normal exit        Error / Timeout
                      │                   │
               status=done         heartbeat expires
               auto_destroy        MachineReaper cleans up
```

### Components / 组件

| Component | Role | Lifecycle |
|-----------|------|-----------|
| **Orchestrator** | HTTP API + session management + MachineReaper | Persistent Fly App |
| **Agent Machine** | Runs Claude Agent SDK task | Ephemeral (auto-destroy) |
| **Redis** | Heartbeat, status, session state | External (Upstash / Fly Redis) |

---

## Prerequisites / 前置条件

- [Fly.io](https://fly.io) account with API token (`flyctl tokens create`)
- [Node.js](https://nodejs.org) 20+
- Redis instance ([Upstash](https://upstash.com) recommended, or Fly Redis)
- [Anthropic API key](https://console.anthropic.com)
- `flyctl` CLI installed

---

## Quick Start: Local Development / 本地开发

```bash
# 1. Copy environment template
cp example/fly-deploy/.env.example example/fly-deploy/.env

# 2. Edit .env with your keys
#    - Set ANTHROPIC_API_KEY
#    - Set FLY_API_TOKEN
#    - REDIS_URL defaults to redis://redis:6379 for docker-compose

# 3. Start services
docker-compose -f example/fly-deploy/docker-compose.yml up --build

# 4. Test the API
curl http://localhost:8080/health

curl -X POST http://localhost:8080/sessions \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "List files in the current directory"}'

# 5. Check session status
curl http://localhost:8080/sessions/<session_id>
```

---

## Deploy to Fly.io / 部署到 Fly.io

### Option A: Automated Script / 自动脚本

```bash
# Set required environment variables
export FLY_API_TOKEN=your_token
export ANTHROPIC_API_KEY=your_key
export REDIS_URL=redis://your-redis-host:6379

# Run the deploy script from the project root
bash example/fly-deploy/deploy.sh
```

### Option B: Manual Steps / 手动步骤

```bash
# 1. Build the project
npm install && npm run build

# 2. Create Fly apps
flyctl apps create claude-agent-app --machines
flyctl apps create claude-orchestrator --machines

# 3. Push the agent image (image only, no running machine)
flyctl deploy -c example/fly-deploy/fly.agent.toml --image-only --remote-only

# 4. Deploy the orchestrator
flyctl deploy -c example/fly-deploy/fly.orchestrator.toml --remote-only

# 5. Set secrets on the orchestrator
flyctl secrets set \
  ANTHROPIC_API_KEY=your_key \
  REDIS_URL=redis://your-redis:6379 \
  FLY_API_TOKEN=your_token \
  -a claude-orchestrator
```

---

## API Reference / API 参考

### `POST /sessions`

Create a new agent session.

**Request:**
```json
{
  "prompt": "Analyze the project structure",
  "session_id": "optional-custom-id"
}
```

**Response (201):**
```json
{
  "session_id": "session-1234567890",
  "machine_id": "d5683606c77108",
  "created_at": "2025-01-15T10:30:00.000Z"
}
```

### `GET /sessions/:id`

Get session status.

**Response (200):**
```json
{
  "session_id": "session-1234567890",
  "status": "done"
}
```

Status values: `null` (running), `"done"`, `"error"` or `{"status":"error","message":"..."}`

### `GET /health`

Health check.

**Response (200):**
```json
{
  "status": "ok"
}
```

---

## Agent SDK / Agent SDK 说明

Each agent machine uses the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) (`@anthropic-ai/claude-agent-sdk`), which provides:

每个 Agent 机器使用 [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)，提供：

- **Built-in tools / 内置工具**: Read, Write, Edit, Bash, Glob, Grep
- **Automatic agentic loop / 自动多轮循环**: The SDK handles multi-turn conversation automatically
- **Max turns / 最大轮数**: Configurable via `config.maxTurns` (default: 25)
- **Permission bypass / 权限绕过**: `permissionMode: "bypassPermissions"` for unattended machine execution

---

## File Structure / 文件结构

```
example/fly-deploy/
├── README.md                 # This file
├── Dockerfile.agent          # Agent machine image
├── Dockerfile.orchestrator   # Orchestrator server image
├── fly.agent.toml            # Fly config for agent app
├── fly.orchestrator.toml     # Fly config for orchestrator app
├── docker-compose.yml        # Local development setup
├── .dockerignore             # Docker build exclusions
├── .env.example              # Environment variable template
└── deploy.sh                 # Automated deployment script
```

---

## Environment Variables / 环境变量

| Variable | Required | Description |
|----------|----------|-------------|
| `FLY_API_TOKEN` | Yes | Fly.io API token |
| `FLY_APP_NAME` | Yes | Fly app name for agent machines |
| `FLY_AGENT_IMAGE` | Yes | Docker image URI for agents |
| `REDIS_URL` | Yes | Redis connection string |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `PORT` | No | HTTP server port (default: 8080) |

---

## Troubleshooting / 常见问题

### Agent machines not starting / Agent 机器无法启动
- Check `FLY_API_TOKEN` is valid: `flyctl auth whoami`
- Verify the agent image exists: `flyctl machines list -a claude-agent-app`
- Check orchestrator logs: `flyctl logs -a claude-orchestrator`

### Sessions timing out / 会话超时
- Default timeout is 600s (10 min). Check `config.maxTurnTimeout`.
- Verify Redis connectivity from both orchestrator and agent machines.
- Check agent logs: find the machine ID from session info, then `flyctl machine logs <id> -a claude-agent-app`

### Redis connection errors / Redis 连接错误
- Ensure Redis URL is accessible from Fly.io (use Upstash or Fly Redis with private networking).
- For local docker-compose, use `redis://redis:6379` (service name, not localhost).

### Claude API errors / Claude API 错误
- Verify `ANTHROPIC_API_KEY` is set as a secret on the orchestrator.
- The orchestrator passes the key to agent machines automatically.
- Check your API key limits at [console.anthropic.com](https://console.anthropic.com).
