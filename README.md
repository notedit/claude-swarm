# Claude Swarm

A Cloudflare Sandbox-based Agent lifecycle management framework with multi-turn conversation support — spin up ephemeral Claude agents on demand, interact across multiple turns, and let sandboxes auto-cleanup.

基于 Cloudflare Sandbox 的 Agent 生命周期管理框架，支持多轮对话 — 按需启动临时 Claude Agent，支持跨多轮交互，沙箱自动回收。

---

## How It Works / 工作原理

### English

Claude Swarm runs Claude AI agents inside [Cloudflare Sandboxes](https://developers.cloudflare.com/sandbox/) — isolated container environments managed by Durable Objects. A Cloudflare Worker acts as the orchestrator, creating sandboxes on demand and routing messages to agents via file-based IPC.

#### Architecture

```
Client (curl / app)
    │
    ├── POST /sessions                  Create session (init sandbox)
    ├── POST /sessions/:id/messages     Send message → async processing
    ├── GET  /sessions/:id/messages/:m  Poll for response
    ├── GET  /sessions/:id/messages     Get conversation history
    ├── GET  /sessions/:id              Session status
    └── DELETE /sessions/:id            Destroy sandbox
    │
    ▼
Cloudflare Worker (src/index.ts)
    │
    ├── getSandbox(env.Sandbox, sessionId)
    ├── sandbox.writeFile("/app/inbox/{msgId}.json")
    ├── sandbox.startProcess("node handle-turn.js {msgId}")
    ├── sandbox.readFile("/app/outbox/{msgId}.json")
    └── sandbox.destroy()
    │
    ▼
Sandbox Container (Dockerfile)
    ├── Node.js 20 + Claude Agent SDK
    ├── /app/inbox/    ← Worker writes messages
    ├── /app/outbox/   ← Agent writes responses
    └── /app/history.json  ← Conversation state
```

#### Multi-turn Flow

1. **Create session** — Worker initializes a sandbox with inbox/outbox directories
2. **Send message** — Worker writes to inbox, starts `handle-turn.js` process
3. **Agent processes** — Loads conversation history, calls Claude SDK with context, writes response to outbox
4. **Poll result** — Client polls outbox until response is ready
5. **Next turn** — Agent automatically has context from all previous turns

#### Lifecycle Management

- Sandboxes auto-sleep after 10 minutes of inactivity (`sleepAfter`)
- Active sessions use `setKeepAlive(true)` to prevent premature sleep
- `DELETE /sessions/:id` immediately destroys the sandbox and frees resources
- No Redis, no heartbeat, no reaper — Cloudflare handles cleanup natively

---

### 中文

Claude Swarm 将 Claude AI Agent 运行在 [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) 中 — 由 Durable Objects 管理的隔离容器环境。Cloudflare Worker 作为协调器，按需创建沙箱，通过基于文件的 IPC 路由消息到 Agent。

#### 多轮对话流程

1. **创建会话** — Worker 初始化沙箱，创建 inbox/outbox 目录
2. **发送消息** — Worker 写入 inbox，启动 `handle-turn.js` 进程
3. **Agent 处理** — 加载对话历史，带上下文调用 Claude SDK，将响应写入 outbox
4. **轮询结果** — 客户端轮询 outbox 直到响应就绪
5. **下一轮** — Agent 自动拥有所有之前轮次的上下文

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
    handle-turn.ts          # Per-message handler (multi-turn) / 单消息处理器
    runner.ts               # One-shot runner (backward compat) / 单次运行器
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
```

### Send Message / 发送消息

```bash
curl -X POST http://localhost:8787/sessions/my-session/messages \
  -H 'Content-Type: application/json' \
  -d '{"content": "List all TypeScript files"}'
# → 202 { "message_id": "msg-...", "status": "processing" }
```

### Poll for Response / 轮询响应

```bash
curl http://localhost:8787/sessions/my-session/messages/msg-123
# → 202 { "status": "processing" }  (still working)
# → 200 { "status": "done", "content": "..." }  (complete)
```

### Get Conversation History / 获取对话历史

```bash
curl http://localhost:8787/sessions/my-session/messages
# → { "session_id": "my-session", "history": [...] }
```

### Get Session Status / 获取会话状态

```bash
curl http://localhost:8787/sessions/my-session
# → { "session_id": "my-session", "status": "done", "message_count": 3 }
```

### Destroy Session / 销毁会话

```bash
curl -X DELETE http://localhost:8787/sessions/my-session
# → { "session_id": "my-session", "destroyed": true }
```

## License

MIT
