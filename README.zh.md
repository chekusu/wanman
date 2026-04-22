# wanman

[English](README.md) | **中文** | [日本語](README.ja.md)

Agent Matrix 框架 —— 运行一个受监督的 Claude Code 或 Codex agent 网络，让它们在你的机器上协同工作。

wanman 是一个开源的本地模式 agent matrix 框架。它在你的机器上运行一个受监督的 Claude Code 或 Codex agent 网络，通过一个 JSON-RPC supervisor 进行协调。

## 它做什么

- 通过带 steer / follow-up 优先级的异步消息总线，协调多个 agent（CEO、dev、devops、marketing、feedback 等）。
- 将每个 agent 作为真实的 Claude Code 或 Codex CLI 子进程运行 —— 你自备 CLI 认证，wanman 负责编排生成、提示和生命周期。
- 将每个 agent 隔离在独立的 worktree 和独立的 `$HOME` 中，这样 agent 绝不会修改你未提交的工作区或 shell 配置文件。
- CLI 优先：一切都可通过 `wanman` 命令和 JSON-RPC supervisor 脚本化、可观测、可复现。

## 快速开始

```bash
# 前置条件：Node 20+、pnpm 9+、git，以及已登录的 Claude Code 或 Codex CLI。
git clone git@github.com:chekusu/wanman.git wanman.dev
cd wanman.dev
pnpm install
pnpm build

# 从源码直接运行；不需要先发布 npm 包。
pnpm --filter @wanman/cli exec wanman takeover /path/to/any/git/repo
```

如果你想生成一个单文件 CLI bundle：

```bash
pnpm --filter @wanman/cli standalone
node packages/cli/dist/wanman.mjs takeover /path/to/any/git/repo
```

如果 `wanman` 已经在你的 `PATH` 中，也可以在目标仓库内直接运行 `wanman takeover .`。

完整流程见 [`docs/quickstart.zh.md`](docs/quickstart.zh.md)。

## CLI 命令

| 命令 | 作用 |
|---------|--------------|
| `wanman send <agent> <msg>` | 向某个 agent 发送消息（`--steer` 会打断目标）。 |
| `wanman recv [--agent <name>]` | 接收并将待处理消息标记为已投递。 |
| `wanman agents` | 列出已注册的 agent 及其当前状态。 |
| `wanman context get` / `context set` | 读写共享的 key/value 上下文。 |
| `wanman escalate <msg>` | 向 CEO agent 上报升级。 |
| `wanman task …` | 管理任务池：`create`、`list`、`get`、`update`、`done`。支持 `--after` 依赖。 |
| `wanman initiative …` | 管理长期 initiative：`create`、`list`、`get`、`update`。 |
| `wanman capsule …` | 管理变更 capsule：`create`、`list`、`mine`、`get`、`update`。 |
| `wanman artifact …` | 存储和检索结构化产物：`put`、`list`、`get`。 |
| `wanman hypothesis …` | 跟踪带状态转移的假设：`create`、`list`、`update`。 |
| `wanman watch` | 实时流式查看 supervisor 和 agent 的活动。 |
| `wanman run <goal>` | 针对一次性目标启动一个 matrix。 |
| `wanman takeover <path>` | 用完整的 agent matrix 接管一个已存在的 git 仓库。 |
| `wanman skill:check [path]` | 校验 skill 文档只引用真实存在的 CLI 命令。 |

运行 `wanman --help` 获取完整的当前命令列表。

## 架构

```
+----------------+          +--------------------+          +-----------------+
|  wanman CLI    |  JSON    |  Supervisor        |  spawn   |  Agent process  |
|  (host shell)  | ---RPC-->|  (local process)   | -------> |  (Claude/Codex) |
|                |  /rpc    |  message/context/  |          |  per-agent $HOME|
|                |          |  task/artifact     |          |  per-agent wt   |
+----------------+          +--------------------+          +-----------------+
                                    |                              |
                                    v                              v
                           +--------------------+        +-----------------+
                           |  files + SQLite    |        |  worktree       |
                           +--------------------+        +-----------------+
```

- `wanman <subcommand>` 通过 JSON-RPC 2.0 与一个 Supervisor 进程通信。
- Supervisor 拥有 message store、context store、任务池、artifact store，并为每个 agent 派生一个子进程。
- 每个 agent 子进程都是一个本地的 Claude Code 或 Codex 子进程，绑定在独立的 worktree 和隔离的 `$HOME` 上。

深入阅读：[`docs/architecture.zh.md`](docs/architecture.zh.md)。

## 配置

| 环境变量 | 含义 |
|---------|---------|
| `WANMAN_URL` | CLI 使用的 Supervisor HTTP 地址（默认 `http://localhost:3120`）。 |
| `WANMAN_AGENT_NAME` | 标识当前 agent；在 agent 进程内作为默认发送者/接收者使用。 |
| `WANMAN_RUNTIME` | `claude`（默认）或 `codex` —— 选择 per-agent CLI 适配器。 |
| `WANMAN_MODEL`、`WANMAN_CODEX_MODEL`、`WANMAN_CODEX_REASONING_EFFORT` | 各 runtime 的模型覆盖配置。 |
| `WANMAN_CODEX_FAST` | 设置后让 Codex 适配器偏向低延迟的默认值。 |
| `WANMAN_SKILL_SNAPSHOTS_DIR` | 覆盖 runtime 物化 skill-activation 快照的目录（默认：shared-skills 目录的同级目录，回退到 `$TMPDIR/wanman-skill-snapshots`）。 |

可选的 `@sandbank.dev/db9` brain 适配器可以挂接进来以实现跨 run 的记忆 —— 见 [`docs/architecture.zh.md`](docs/architecture.zh.md#brain--persistence)。

## Agent 配置

Agent 定义集中在单个 JSON 文件中：

```json
{
  "agents": [
    { "name": "echo", "lifecycle": "24/7", "model": "standard", "systemPrompt": "..." },
    { "name": "ping", "lifecycle": "on-demand", "model": "standard", "systemPrompt": "..." }
  ],
  "dbPath": ".wanman/wanman.db",
  "port": 3120,
  "workspaceRoot": ".wanman/agents"
}
```

每条 agent 条目包含：
- `name` —— 消息总线上使用的唯一标识。
- `lifecycle` —— `24/7`（持续重生循环）或 `on-demand`（空闲直到被触发）。
- `model` —— 通常使用抽象 tier（`high` 或 `standard`）；runtime 适配器会映射到 Claude 或 Codex 的默认模型，也可以通过环境变量覆盖。
- `systemPrompt` —— 内置的角色设定/使命；agent 还会自动发现 `~/.claude/skills/` 下的共享 skill 文件。
- 可选字段 `cron`、`events`、`tools` —— 完整 schema 见架构文档。

## 测试

```bash
pnpm typecheck
pnpm test
pnpm exec vitest run --coverage --coverage.reporter=text-summary --coverage.reporter=json-summary --coverage.exclude='**/dist/**'
```

当前覆盖率目标是行覆盖率至少 90%。最新一次本地验证结果为 `Lines: 90.17%`；机器可读的汇总会写入 `coverage/coverage-summary.json`。

## 项目结构

```
wanman.dev/
  packages/
    cli/                 wanman CLI (send/recv/task/artifact/run/takeover/...)
    core/                Shared types, JSON-RPC protocol, skills (core/skills/)
    host-sdk/            Host-side SDK for embedding wanman into other tools
    runtime/             Supervisor, agent process manager, SQLite stores, adapters
  docs/                  Architecture and quickstart guides
```

当前已内置的共享 skills（`packages/core/skills/`）：
- `artifact-naming`、`artifact-quality` —— agent 产出物的命名与质量规范。
- `cross-validation` —— CEO 对各 agent 产出进行一致性检查。
- `research-methodology` —— 市场/数据调研方法论。
- `wanman-cli` —— 供 agent 在运行时查阅的 CLI 命令参考。
- `workspace-conventions` —— agent 工作区内的文件系统约定。

## 延伸阅读

- [快速开始](docs/quickstart.zh.md) —— 针对任意 git 仓库的首次运行流程。
- [架构](docs/architecture.zh.md) —— agent 生命周期、JSON-RPC、存储、适配器。
- [贡献指南](CONTRIBUTING.zh.md) —— 测试、类型检查、提交约定。

## 许可证

Apache-2.0 —— 见 [LICENSE](LICENSE)。
