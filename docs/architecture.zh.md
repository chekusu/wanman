# 架构

[English](architecture.md) | **中文** | [日本語](architecture.ja.md)

本文档面向刚接触 wanman 代码库的开发者，是他们应当优先阅读的导览。内容覆盖 supervisor 的形态、agent 如何被派生以及彼此通信、以及状态存放在何处。

## 1. 系统总览

```
+----------------+              +--------------------------------+
|  wanman CLI    |              |  Supervisor process (local)    |
|  (host shell)  |  JSON-RPC    |                                |
|                | -----------> |  MessageStore  ContextStore    |
|  send/recv/    |  HTTP :3120  |  TaskPool      ArtifactStore   |
|  task/agents/  |              |  InitiativeBoard               |
|  artifact/...  |              |  CronScheduler                 |
+----------------+              |  Relay         LoopEventBus    |
                                |                                |
                                |  +--------------------------+  |
                                |  |  AgentProcess[]          |  |
                                |  |  (spawns Claude/Codex    |  |
                                |  |   CLI children)          |  |
                                |  +--------------------------+  |
                                +----------------+---------------+
                                                 |
                                                 v
                                    Claude Code / Codex subprocess
                                    (per-agent worktree + $HOME)
```

CLI 只是一个薄薄的 JSON-RPC 2.0 客户端。真正有趣的东西 —— 进程管理、持久化、路由 —— 都在 supervisor 里。supervisor 是一个普通的本地 Node.js 进程；CLI 只需要一个 `WANMAN_URL` 就能连上它。

## 2. Agent 生命周期

每个 agent 在 agents 配置中都声明了一个 `lifecycle`：

### 2.1 `24/7` —— 持续重生

```
start()
  +-> runLoop()
        +- relay.recv()            -- pull pending messages
        +- spawnClaudeOrCodex()    -- boot the CLI subprocess with those as prompt
        +- wait()                  -- block until the subprocess exits
        +- sleep(RESPAWN_DELAY_MS) -- cooldown
        +- repeat
```

- 每次循环都派生一个全新的 CLI 子进程。
- 如果有待处理消息，它们将作为初始 prompt；否则使用默认的 "you are alive, check your inbox" 提示。
- 退出 → 冷却 → 重生。该循环会被 `handleSteer()` 打断（见下文）。

### 2.2 `on-demand` —— 空闲直到被触发

```
start()
  +-> state = 'idle'   (no CLI subprocess running)
        +- trigger() or handleSteer()
             +- relay.recv()
             +- spawnClaudeOrCodex()
             +- wait()
        +- state = 'idle' again
```

- 初始状态为 `idle`；在有东西戳它之前不消耗 CPU。
- 一条 steer 优先级消息或一次 cron tick 触发一次执行，执行完毕后 agent 回到 `idle`。

### 2.3 Agent 状态

| 状态 | 含义 |
|-------|---------|
| `idle` | 等待中（on-demand 的常态）。 |
| `running` | 有一个 Claude Code 或 Codex 子进程正在运行。 |
| `stopped` | 被手动停止或正在关停。 |
| `error` | 最近一次崩溃；supervisor 会重试。 |

## 3. 消息系统

### 3.1 优先级

| 优先级 | 值 | 效果 |
|----------|-------|--------|
| `steer` | 0 | **打断**目标当前的子进程；下一次循环最先取到它。 |
| `followUp` | 1 | 普通排队；在下一次循环按时间戳顺序处理。 |

### 3.2 Steer 机制

```
sender                        Relay                         target agent
  |                             |                               |
  |-- agent.send(steer) ------->|                               |
  |                             |-- messageStore.enqueue() -----|
  |                             |-- steerCallback(agent) ------>|
  |                             |                               |-- kill(currentProcess)
  |                             |                               |
  |                             |                 (next loop)   |
  |                             |                               |-- relay.recv()
  |                             |                               |   (steer sorted first)
  |                             |                               |-- spawnClaudeOrCodex(steerMsg)
```

relay 的 steer 回调通知 `AgentProcess` 对当前的 Claude/Codex 子进程发送 SIGKILL。随后 run loop 的常规重生路径会因 SQL 排序的缘故最先取到那条 steer 消息。

### 3.3 投递保证

- `send()` 返回前，消息已经被持久化到 SQLite（`messages` 表）。
- `recv()` 返回待处理（`delivered = 0`）的行，并在同一事务中把它们标记为 delivered —— 不会重复投递。
- 排序：`ORDER BY CASE priority WHEN 'steer' THEN 0 ELSE 1 END, timestamp ASC`。

### 3.4 消息形态

```ts
interface AgentMessage {
  id: string              // UUID
  from: string            // sender agent name (or "system")
  to: string              // recipient agent name
  priority: 'steer' | 'followUp'
  content: string         // plain text prompt body
  timestamp: number       // unix ms
  delivered: boolean
}
```

## 4. Context store

基于 SQLite 的跨 agent 共享 key/value 存储。适合存放系统级状态，比如 "last build result" 或 "current MRR"。

```ts
interface ContextEntry {
  key: string
  value: string
  updatedBy: string  // agent name
  updatedAt: number  // unix ms
}
```

RPC 方法：`context.get`、`context.set`、`context.list`。`set` 是 upsert（`INSERT ... ON CONFLICT DO UPDATE`）。

## 5. 任务池、initiative、artifact、hypothesis

除了原始消息之外，supervisor 还拥有一批结构化的状态：

- **TaskPool** —— 归属于某个 agent 的任务，带状态（`pending`、`in_progress`、`done`、`blocked`）、优先级以及 `--after` 依赖。`wanman task list` 会渲染感知依赖关系的视图。
- **InitiativeBoard** —— 更长期、跨多任务的 initiative。
- **ArtifactStore** —— 通过 `wanman artifact put` 产出的结构化输出（调研摘要、计划等）。artifact 包含 kind、path、content 和 JSON 元数据。
- **HypothesisPool** —— 带状态转移的实验式假设。
- **ChangeCapsulePool** —— agent 可以评审的变更捆绑提案。

它们其实都是同一个 `wanman.db` 下的 SQLite 表，通过 JSON-RPC 访问。

## 6. 外部事件与 cron

除了 agent 之间的消息，matrix 还有两类异步输入：

- **`POST /events`** —— 外部系统（CI、webhook、人类脚本）推送一个 `ExternalEvent` 对象。supervisor 遍历所有 agent，对任何 `definition.events[]` 包含该事件类型的 agent，把序列化后的 payload 作为 follow-up 消息塞入其收件箱。
- **CronScheduler** —— 每 60 秒运行一次，检查每个 agent 的 `cron` 表达式，命中时将普通 follow-up 消息加入队列。空闲的按需 agent 由消息通道唤醒，运行中的 agent 在当前工作结束后处理队列。标准 5 字段 cron：`min hour dom mon dow`。

这两个是 wanman 与 "你基础设施其他部分" 对接的缝隙，而不把任何具体 webhook 提供方硬编码进来。

## 7. Runtime 适配器

每个 agent 子进程都是 Claude Code 或 Codex 子进程。supervisor 通过 `WANMAN_RUNTIME`（默认 `claude`）进行选择，若 per-agent 有覆盖也会生效。

- `claude-adapter.ts` / `claude-code.ts` —— 用 agent 的 system prompt 派生 `claude`，注入 skill 文件，把结构化事件流回传给 supervisor。
- `codex-adapter.ts` —— 形态相同，面向 `@openai/codex`。`WANMAN_CODEX_MODEL` 和 `WANMAN_CODEX_REASONING_EFFORT` 控制模型选择。

两个适配器发出同一套 `AgentRunEvent` 流，所以 supervisor 和 CLI 不关心跑的是哪一个。新增一个适配器只需要实现那个事件契约，并在 `agent-process.ts` 中注册它。

## 8. Worktree 与 home 隔离

在派生首个子进程之前，supervisor 会为每个 agent 准备：

- 一个从当前 `HEAD` 物化到 `.wanman/worktree/` 下的 **worktree**。agent 编辑的是它，不是你真实的工作区。
- 一个 **per-agent `$HOME`**，位于 `.wanman/home/<agent>/`，内含生成好的 `wanman` 和 `pnpm` 包装脚本。Shell 配置文件写入、`.npmrc` 编辑等都被圈在里面。
- 该 home 下的 **per-agent `.claude/`**（或 `.codex/`），这样两个 agent 不会互相踩踏彼此的 CLI 状态。

每个 agent 的 `$PATH` 下的 `wanman` 包装脚本指向同一个 CLI 二进制文件，但预设了 `WANMAN_AGENT_NAME`，让 agent 视角下不带参数的 `wanman recv` "正好能用"。

## 9. 共享 skills

`packages/core/skills/*/SKILL.md` 随 runtime bundle 一同发布。supervisor 启动时，`setupSharedSkills()`（位于 `shared-skill-manager.ts`）将它们物化到每个 agent 的 `~/.claude/skills/`，这样 Claude Code 就能自动发现它们。

Skill 快照 —— 绑定到特定 run 的不可变副本 —— 被写入由 `WANMAN_SKILL_SNAPSHOTS_DIR` 解析出的目录，或 shared-skills 目录的同级目录，实在不行回落到 `$TMPDIR/wanman-skill-snapshots`。这个机制让你可以审计某个任务当时到底用的是哪个版本的 skill。

当前已内置的 skills：
- `artifact-naming`、`artifact-quality` —— agent 产出物的命名与质量规范。
- `cross-validation` —— CEO 对各 agent 产出进行一致性检查。
- `research-methodology` —— 市场/数据调研方法论。
- `wanman-cli` —— agent 在运行时查阅的 CLI 命令参考。
- `workspace-conventions` —— agent 在工作区内应遵循的文件布局。

## 10. Brain 与持久化

两层持久化，对 agent 代码都是可选的：

- **本地 SQLite（agents 配置中的 `dbPath`）** —— 始终存在。消息、context、任务、artifact、hypothesis、capsule。在同一个 workspace 内跨 supervisor 重启持久。
- **`@sandbank.dev/db9` brain 适配器（可选）** —— 如果 runtime 配置了 db9 连接（token + db 名），它会把 artifact 和 context 镜像到一个跨 run、跨机器的存储中。适合多台 supervisor 共享记忆的场景，或者 run 后分析。OSS 构建把 db9 视为可选对等依赖 —— 缺失它只是禁用镜像而已。

## 11. HTTP 接口速览

| 端点 | 方法 | 用途 |
|----------|--------|---------|
| `/health` | GET | supervisor + 各 agent 的状态快照。 |
| `/rpc` | POST | JSON-RPC 2.0 —— 主要的 CLI 接口面。 |
| `/events` | POST | 外部事件入口。 |

主要的 RPC 方法：

| 方法 | 用途 |
|--------|---------|
| `agent.send` / `agent.recv` / `agent.list` | Agent 之间的消息。 |
| `context.get` / `context.set` / `context.list` | 共享 context。 |
| `task.*` / `initiative.*` / `capsule.*` / `artifact.*` / `hypothesis.*` | 结构化状态。 |
| `event.push` | 与 `POST /events` 相同，供 RPC 客户端使用。 |
| `health.check` | 通过 RPC 获取健康快照。 |

错误使用标准的 JSON-RPC 错误码（`-32700` 解析错误、`-32600` 无效请求、`-32601` 方法未找到、`-32602` 参数无效、`-32603` 内部错误），外加 `-32000`（agent 未找到）和 `-32001`（agent 未运行）。

## 12. 代码在哪

```
packages/
  cli/         Commands (send, recv, task, artifact, run, takeover, watch).
               Speaks JSON-RPC to the supervisor. No business logic.
  core/        Shared types and JSON-RPC protocol definitions.
               core/skills/ ships the SKILL.md bundle.
  host-sdk/    Programmatic embedding SDK for host-side integrations.
  runtime/     The supervisor. Agent process manager, SQLite stores,
               Claude/Codex adapters, cron scheduler, event router.
```

关于 CLI 接口面和环境变量，见 [README](../README.zh.md#cli-commands)。
