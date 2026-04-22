# Quickstart

This walks through a complete first-run of wanman against any git repo on your machine.

## 1. Prerequisites

- **Node.js 20+** and **pnpm 9+** (`corepack enable && corepack prepare pnpm@9.15.0 --activate`).
- **git**.
- An authenticated Claude Code CLI *or* Codex CLI — wanman spawns these as agent subprocesses and relies on whatever auth they already have.
  - Claude Code: install `@anthropic-ai/claude-code` globally and run its login flow (`claude` then follow prompts).
  - Codex: install `@openai/codex` globally and sign in per the Codex CLI docs.
- **Any existing git repository** you're willing to let agents read and scribble in. wanman will copy it into an isolated worktree and never mutate your dirty checkout.

Optional:
- BoxLite, if you want microVM isolation — see [local-sandbox.md](local-sandbox.md).
- A `@sandbank.dev/db9` brain, if you want cross-run memory — see [architecture.md](architecture.md#brain--persistence).

## 2. Clone, install, build

```bash
git clone <repo-url> wanman.dev
cd wanman.dev
pnpm install
pnpm build
```

`pnpm build` produces a standalone CLI bundle at `packages/cli/dist/index.js`. Either add it to your `PATH` or use `pnpm --filter @wanman/cli exec wanman ...` during development.

For local iteration you can `npm link` the CLI:

```bash
cd packages/cli
npm link
wanman --help
```

## 3. Take over a git repo

From the root of any existing git project:

```bash
cd /path/to/any/git/repo
wanman takeover .
```

What happens:
1. wanman creates `.wanman/` inside the repo to hold its local state.
2. It materializes `.wanman/worktree/` from the current `HEAD` so agents operate on a clean snapshot, not your dirty working tree.
3. It starts a supervisor on an auto-selected `127.0.0.1` port and waits for health.
4. It spawns agents (Claude Code subprocesses by default) under an isolated `.wanman/home/` so shell profile changes stay out of your real `$HOME`.
5. Takeover stays in the foreground, streaming agent activity.

Choose a runtime with `--runtime`:

```bash
wanman takeover . --runtime claude   # default
wanman takeover . --runtime codex
```

## 4. Talk to the matrix

In a second terminal (same shell, so it inherits `WANMAN_URL` if set, or uses the default `http://localhost:3120`):

```bash
wanman agents                              # list registered agents and their states
wanman send ceo "Build me a sample TODO API"
wanman watch                               # live-stream supervisor events
```

`send` places a follow-up message on the CEO's inbox. Use `--steer` if you want to interrupt whatever the agent is currently doing:

```bash
wanman send ceo --steer "Stop — focus on the API, not the landing page"
```

To read the replies (and mark them delivered):

```bash
wanman recv --agent ceo
```

## 5. Inspect artifacts

Agents produce structured artifacts — research summaries, plans, financial models, etc. — through `wanman artifact put`. To browse them:

```bash
wanman artifact list                # newest first, all agents
wanman artifact list --agent ceo    # filter by producer
wanman artifact get <id>            # full content + metadata
```

Artifact naming and quality conventions are in [`packages/core/skills/artifact-naming/SKILL.md`](../packages/core/skills/artifact-naming/SKILL.md) and [`artifact-quality/SKILL.md`](../packages/core/skills/artifact-quality/SKILL.md).

You can inspect tasks and initiatives similarly:

```bash
wanman task list
wanman task get <task-id>
wanman initiative list
```

## 6. Cleanup

Everything wanman creates for a takeover lives under `.wanman/` inside the target repo:

```
.wanman/
  worktree/   clean checkout the agents actually edit
  home/       isolated $HOME for agent subprocesses
  agents/     per-agent workspace dirs (output, scratch)
  wanman.db   SQLite store: messages, context, tasks, artifacts, ...
  logs/       supervisor and agent logs
```

To reset state for a repo, stop `wanman takeover` (Ctrl+C) and:

```bash
rm -rf .wanman
```

Your real working tree is untouched — wanman only ever wrote inside `.wanman/`.

## 7. Where next

- Want microVM isolation so a misbehaving agent can't touch your `$HOME`? See [local-sandbox.md](local-sandbox.md).
- Want to understand the JSON-RPC protocol, message priorities, and agent lifecycles? See [architecture.md](architecture.md).
- Want to contribute? See [CONTRIBUTING.md](../CONTRIBUTING.md).
