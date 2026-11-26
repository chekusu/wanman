# 快速开始

[English](quickstart.md) | **中文** | [日本語](quickstart.ja.md)

本文带你完整走一遍：在你机器上任意一个 git 仓库上首次运行 wanman。

## 1. 前置条件

- **Node.js 20+** 和 **pnpm 9+**（`corepack enable && corepack prepare pnpm@9.15.0 --activate`）。
- **git**。
- 已认证的 Claude Code CLI *或* Codex CLI —— wanman 会把它们当成 agent 子进程来派生，并直接复用它们已有的认证。
  - Claude Code：全局安装 `@anthropic-ai/claude-code` 并运行登录流程（执行 `claude` 然后按提示操作）。
  - Codex：全局安装 `@openai/codex`，按 Codex CLI 文档完成登录。
- **任意现有的 git 仓库**，你愿意让 agent 在里面读取和涂写。wanman 会把它复制到一个隔离的 worktree，从不会修改你未提交的工作区。

可选：
- `@sandbank.dev/db9` brain 适配器，用于获得跨 run 的记忆 —— 见 [architecture.zh.md](architecture.zh.md#brain--persistence)。

## 2. Clone、安装、构建

```bash
git clone git@github.com:chekusu/wanman.git wanman.dev
cd wanman.dev
pnpm install
pnpm build
```

`pnpm build` 会编译整个 workspace，并生成 CLI 入口 `packages/cli/dist/index.js`。在源码开发阶段，用 `pnpm --filter @wanman/cli exec wanman ...` 直接运行；如果需要单文件 bundle，再执行 `pnpm --filter @wanman/cli standalone` 生成 `packages/cli/dist/wanman.mjs`。

本地迭代时可以用 `npm link` 链接该 CLI：

```bash
cd packages/cli
npm link
wanman --help
```

## 3. 接管一个 git 仓库

在任意现有 git 项目的根目录下：

```bash
cd /path/to/any/git/repo
wanman takeover .
```

过程如下：
1. wanman 在仓库内创建 `.wanman/` 来保存本地状态。
2. 它从当前 `HEAD` 物化出 `.wanman/worktree/`，这样 agent 操作的是一个干净的快照，而不是你未提交的工作区。
3. 它在自动挑选的 `127.0.0.1` 端口上启动一个 supervisor，并等待健康检查通过。
4. 它在一个隔离的 `.wanman/home/` 下派生 agent（默认是 Claude Code 子进程），让 shell 配置文件的改动不会污染你真实的 `$HOME`。
5. takeover 会保持前台运行，实时流式输出 agent 活动。

用 `--runtime` 选择 runtime：

```bash
wanman takeover . --runtime claude   # default
wanman takeover . --runtime codex
```

## 4. 与 matrix 对话

在第二个终端中（同样的 shell，这样如果设置了 `WANMAN_URL` 会继承，否则使用默认的 `http://localhost:3120`）：

```bash
wanman agents                              # list registered agents and their states
wanman send ceo "Build me a sample TODO API"
wanman watch                               # live-stream supervisor events
```

`send` 会在 CEO 的收件箱里放入一条 follow-up 消息。如果你想打断 agent 当前的工作，使用 `--steer`：

```bash
wanman send ceo --steer "Stop — focus on the API, not the landing page"
```

读取回复（并标记为已投递）：

```bash
wanman recv --agent ceo
```

## 5. 了解 takeover 交付循环

matrix 跑起来后，默认的本地 takeover 工作流是：

1. CEO 把目标拆成 task 和 change capsule。
2. Dev agent 在 `wanman/<task-slug>` 分支上做范围受控的修改，并提交带 coverage 说明的 PR。
3. 只有当 PR 正文或 CI 显示变更文件的 coverage 至少达到 95% 时，CTO 才会开始 review。
4. PR 通过后合并，task 和 capsule 的状态继续记录在 `.wanman/` 中。

## 6. 查看 artifact

Agent 通过 `wanman artifact put` 产出结构化的 artifact —— 调研摘要、计划、财务模型等。浏览它们：

```bash
wanman artifact list                # newest first, all agents
wanman artifact list --agent ceo    # filter by producer
wanman artifact get <id>            # full content + metadata
```

Artifact 的命名和质量规范在 [`packages/core/skills/artifact-naming/SKILL.md`](../packages/core/skills/artifact-naming/SKILL.md) 和 [`artifact-quality/SKILL.md`](../packages/core/skills/artifact-quality/SKILL.md)。

你也可以用类似方式查看 task 和 initiative：

```bash
wanman task list
wanman task get <task-id>
wanman initiative list
```

## 7. 清理

wanman 为一次 takeover 所创建的一切都放在目标仓库内的 `.wanman/` 下：

```
.wanman/
  worktree/   clean checkout the agents actually edit
  home/       isolated $HOME for agent subprocesses
  agents/     per-agent workspace dirs (output, scratch)
  wanman.db   SQLite store: messages, context, tasks, artifacts, ...
  logs/       supervisor and agent logs
```

要重置某个仓库的状态，停止 `wanman takeover`（Ctrl+C），然后：

```bash
rm -rf .wanman
```

你真实的工作区毫发无损 —— wanman 只在 `.wanman/` 里写过东西。

## 8. 接下来去哪里

- 想理解 JSON-RPC 协议、消息优先级和 agent 生命周期？见 [architecture.zh.md](architecture.zh.md)。
- 想贡献代码？见 [CONTRIBUTING.zh.md](../CONTRIBUTING.zh.md)。
