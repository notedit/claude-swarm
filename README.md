# Claude Swarm

A Fly Machines Agent lifecycle management framework — spin up ephemeral Claude agents on demand, keep them healthy with heartbeats, and reclaim resources automatically.

基于 Fly Machines 的 Agent 生命周期管理框架 — 按需启动临时 Claude Agent，通过心跳保活，并自动回收资源。

---

## How It Works / 工作原理

### English

Claude Swarm runs Claude AI agents as short-lived [Fly Machines](https://fly.io/docs/machines/). Each machine starts on demand, does its work, and is destroyed as soon as it finishes. Two recycling layers ensure no zombie machines are left running:

#### Architecture

```
User Request
    │
    ▼
Orchestrator
    ├── Redis: existing session? ──yes──► forward to existing Machine
    │
    └──no──► Fly API: create new Machine (~1-2s cold start)
                  │
                  ▼
            Machine starts
                  ├── Agent process begins
                  ├── Heartbeat loop starts (every 10s → Redis)
                  └── Claude SDK executes task
                          │
                  ┌───────┴────────┐
             Normal exit        Error / Timeout
                  │                   │
           del heartbeat         heartbeat TTL
           set status=done       expires (30s)
           process exits              │
                  │            Reaper sweeps (30s)
             auto_destroy ◄─────────┘
             destroys Machine
```

#### Layer 1 — Automatic Recycling (Fly native)

Every Machine is created with `auto_destroy: true` and a `stop_config` timeout of 5 minutes. When the agent process exits normally, Fly automatically stops and destroys the machine — no code required.

#### Layer 2 — Active Recycling (MachineReaper)

The `MachineReaper` runs as a background loop in the Orchestrator. Every 30 seconds it scans all running machines and kills any that match one of three conditions:

| Condition | Trigger | Action |
|-----------|---------|--------|
| `task_done` | `agent:status:{id}` = `"done"` in Redis | Stop + destroy |
| `heartbeat_lost` | Heartbeat key expired (TTL 30s, no renewal) | Stop + destroy |
| `timeout` | Machine running > 600s | Stop + destroy |

#### Agent Heartbeat

Inside each Machine, `HeartbeatReporter` writes to Redis every 10 seconds:

```
agent:heartbeat:{sessionId}  →  { machine_id, started_at, status }   TTL 30s
agent:status:{sessionId}     →  "done" | "error"                      TTL 1h
agent:machine:{sessionId}    →  { session_id, machine_id, created_at }
```

On clean completion, `markDone()` deletes the heartbeat key and sets `status=done`, letting the Reaper (or `auto_destroy`) clean up immediately.

---

### 中文

Claude Swarm 将 Claude AI Agent 作为短生命周期的 [Fly Machines](https://fly.io/docs/machines/) 运行。每台机器按需启动，完成任务后立即销毁。两层回收机制确保不会留下僵尸机器：

#### 架构说明

```
用户请求
    │
    ▼
Orchestrator（协调器）
    ├── 查询 Redis：session 是否已有 Machine？──是──► 直接转发请求
    │
    └──否──► 调用 Fly API 创建新 Machine（~1-2s 启动）
                  │
                  ▼
            Machine 启动
                  ├── Agent 进程启动
                  ├── 心跳协程启动（每10s → Redis）
                  └── Claude SDK 执行任务
                          │
                  ┌───────┴────────┐
             正常完成           异常/超时
                  │                   │
           删除心跳 key          心跳 TTL 过期（30s）
           写入 status=done           │
           进程退出             Reaper 巡检发现（30s）
                  │                   │
             auto_destroy ◄───────────┘
             自动销毁 Machine
```

#### 第一层：自动回收（Fly 原生）

每台 Machine 创建时配置 `auto_destroy: true` 以及 5 分钟的 `stop_config` 超时。Agent 进程正常退出后，Fly 自动停止并销毁机器，无需额外代码。

#### 第二层：主动回收（MachineReaper）

`MachineReaper` 作为后台循环运行在 Orchestrator 中，每 30 秒扫描所有运行中的 Machine，满足以下任一条件即触发回收：

| 条件 | 触发方式 | 处理动作 |
|------|---------|---------|
| `task_done` | Redis 中 `agent:status:{id}` = `"done"` | 停止并销毁 |
| `heartbeat_lost` | 心跳 key 过期（TTL 30s 未续期） | 停止并销毁 |
| `timeout` | Machine 运行超过 600s | 停止并销毁 |

#### Agent 心跳机制

每台 Machine 内部，`HeartbeatReporter` 每 10 秒向 Redis 写入：

```
agent:heartbeat:{sessionId}  →  { machine_id, started_at, status }   TTL 30s
agent:status:{sessionId}     →  "done" | "error"                      TTL 1h
agent:machine:{sessionId}    →  { session_id, machine_id, created_at }
```

任务正常结束时，`markDone()` 删除心跳 key 并写入 `status=done`，Reaper 或 `auto_destroy` 会立即介入清理。

---

## Project Structure / 项目结构

```
src/
  types.ts                    # Shared type definitions / 共享类型
  config.ts                   # Tunable parameters / 可调参数
  agent/
    heartbeat.ts              # HeartbeatReporter (runs inside Machine)
    runner.ts                 # Agent container entry point / 容器入口
  orchestrator/
    reaper.ts                 # MachineReaper — zombie cleanup / 僵尸回收
    orchestrator.ts           # Session management + Machine creation / 会话管理
```

## Configuration / 配置参数

| Parameter | Default | Description |
|-----------|---------|-------------|
| `heartbeatTtl` | 30s | Redis key TTL for heartbeat / 心跳 key 过期时间 |
| `heartbeatInterval` | 10s | How often agent reports / 心跳上报间隔 |
| `reaperInterval` | 30s | How often reaper sweeps / 巡检间隔 |
| `stopConfigTimeout` | 300s | Fly Machine idle stop timeout / 空闲停止超时 |
| `maxTurnTimeout` | 600s | Hard kill after this duration / 最长运行时间 |
| `maxTurns` | 25 | Max Claude turns per session / 最大对话轮数 |

## Prerequisites / 前置条件

- [Fly.io](https://fly.io) account with API token
- Redis instance (e.g. [Upstash](https://upstash.com))
- Node.js 20+

## Getting Started / 快速开始

```bash
# Install dependencies / 安装依赖
npm install

# Build / 编译
npm run build

# Set environment variables / 配置环境变量
export FLY_API_TOKEN=your_token
export FLY_APP_NAME=your-agent-app
export FLY_AGENT_IMAGE=registry.fly.io/your-agent:latest
export REDIS_URL=redis://...

# Run orchestrator / 启动协调器
npm start
```

## License

MIT
