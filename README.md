# Claude Swarm

A Cloudflare Sandbox-based Agent lifecycle management framework with multi-turn conversation support — spin up ephemeral Claude agents on demand, interact across multiple turns, and let sandboxes auto-cleanup.

基于 Cloudflare Sandbox 的 Agent 生命周期管理框架，支持多轮对话 — 按需启动临时 Claude Agent，支持跨多轮交互，沙箱自动回收。

---

## How It Works / 工作原理

### English

Claude Swarm runs Claude AI agents inside [Cloudflare Sandboxes](https://developers.cloudflare.com/sandbox/) — isolated container environments managed by Durable Objects. A Cloudflare Worker acts as the orchestrator, creating sandboxes on demand and forwarding messages to the agent's HTTP server via `sandbox.fetch()`.

#### Architecture

```
Client (curl / app)
    │
    ├── POST /sessions                  Create session (start agent server)
    ├── POST /sessions/:id/messages     Send message → sandbox.fetch()
    ├── GET  /sessions/:id/messages     Get conversation history
    ├── GET  /sessions/:id              Session status
    └── DELETE /sessions/:id            Destroy sandbox
    │
    ▼
Cloudflare Worker (src/index.ts)
    │
    ├── getSandbox(env.Sandbox, sessionId)
    ├── sandbox.startProcess("node /app/dist/agent/server.js")
    ├── sandbox.fetch(POST /message)  → agent processes + responds
    ├── sandbox.fetch(GET /messages)  → conversation history
    └── sandbox.destroy()
    │
    ▼
Sandbox Container (Dockerfile)
    ├── Node.js 20 + Claude Agent SDK
    └── Agent HTTP server (src/agent/server.ts)
        ├── POST /message   → process with Claude SDK
        ├── GET  /messages  → return conversation history
        └── Conversation state in memory
```

#### Multi-turn Flow

1. **Create session** — Worker creates sandbox, starts the agent HTTP server
2. **Send message** — Worker forwards request via `sandbox.fetch()` to agent
3. **Agent processes** — Builds prompt with conversation history, calls Claude SDK
4. **Direct response** — Agent returns response synchronously (no polling needed)
5. **Next turn** — Agent retains conversation state in memory across turns

#### Lifecycle Management

- Sandboxes auto-sleep after 10 minutes of inactivity (`sleepAfter`)
- Active sessions use `setKeepAlive(true)` to prevent premature sleep
- `DELETE /sessions/:id` immediately destroys the sandbox and frees resources
- No Redis, no heartbeat, no reaper — Cloudflare handles cleanup natively

---

### 中文

Claude Swarm 将 Claude AI Agent 运行在 [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) 中 — 由 Durable Objects 管理的隔离容器环境。Cloudflare Worker 作为协调器，按需创建沙箱，通过 `sandbox.fetch()` 将消息转发到 Agent 的 HTTP 服务器。

#### 多轮对话流程

1. **创建会话** — Worker 创建沙箱，启动 Agent HTTP 服务器
2. **发送消息** — Worker 通过 `sandbox.fetch()` 转发请求到 Agent
3. **Agent 处理** — 构建含对话历史的提示词，调用 Claude SDK
4. **直接响应** — Agent 同步返回响应（无需轮询）
5. **下一轮** — Agent 在内存中保持对话状态，跨轮次保留上下文

#### 生命周期管理

- 沙箱在 10 分钟无活动后自动休眠（`sleepAfter`）
- 活跃会话使用 `setKeepAlive(true)` 防止提前休眠
- `DELETE /sessions/:id` 立即销毁沙箱并释放资源
- 无需 Redis、无需心跳、无需 Reaper — Cloudflare 原生处理清理

---

## Project Structure / 项目结构

```
src/
  index.ts                  # Worker entry point / Worker 入口
  types.ts                  # Shared type definitions / 共享类型
  config.ts                 # Tunable parameters / 可调参数
  agent/
    server.ts               # Agent HTTP server (multi-turn) / Agent HTTP 服务器
    runner.ts               # One-shot runner (standalone mode) / 单次运行器
  orchestrator/
    orchestrator.ts         # Session + sandbox management / 会话管理
wrangler.toml               # Cloudflare Worker config / Worker 配置
Dockerfile                  # Sandbox container image / 沙箱容器镜像
```

## Configuration / 配置参数

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxTurns` | 25 | Max Claude SDK turns per message / 每条消息的最大对话轮数 |
| `maxTurnTimeout` | 600s | Max processing time per message / 每条消息的最大处理时间 |
| `sandboxSleepAfter` | 10m | Auto-sleep after inactivity / 无活动后自动休眠 |

## Prerequisites / 前置条件

- [Cloudflare](https://cloudflare.com) account
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed and authenticated
- Docker (for building sandbox container images)
- Node.js 20+

## Getting Started / 快速开始

```bash
# Install dependencies / 安装依赖
npm install

# Local development / 本地开发
npm run dev

# Deploy to Cloudflare / 部署到 Cloudflare
npm run deploy

# Set secrets / 设置密钥
wrangler secret put ANTHROPIC_API_KEY
```

## API Reference / API 参考

### Create Session / 创建会话

```bash
curl -X POST http://localhost:8787/sessions \
  -H 'Content-Type: application/json' \
  -d '{"session_id": "my-session"}'
# → 201 { "session_id": "my-session", "status": "running", ... }
```

### Send Message / 发送消息

```bash
curl -X POST http://localhost:8787/sessions/my-session/messages \
  -H 'Content-Type: application/json' \
  -d '{"content": "List all TypeScript files"}'
# → 200 { "session_id": "my-session", "role": "assistant", "content": "..." }
```

Responses are synchronous — the request blocks until the agent finishes processing.

### Get Conversation History / 获取对话历史

```bash
curl http://localhost:8787/sessions/my-session/messages
# → { "session_id": "my-session", "history": [...] }
```

### Get Session Status / 获取会话状态

```bash
curl http://localhost:8787/sessions/my-session
# → { "session_id": "my-session", "status": "running", "message_count": 3 }
```

### Destroy Session / 销毁会话

```bash
curl -X DELETE http://localhost:8787/sessions/my-session
# → { "session_id": "my-session", "destroyed": true }
```

## License

MIT
