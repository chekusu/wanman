# wanman

Agent Matrix framework — run a supervised network of Claude Code or Codex agents that collaborate on your machine.

wanman is an open-source local-mode agent matrix framework. It runs Claude Code or Codex agents on your machine, coordinated by a JSON-RPC supervisor and sandboxed via [`@sandbank.dev/boxlite`](https://www.npmjs.com/package/@sandbank.dev/boxlite). For the hosted multi-tenant product (web dashboard, launch/story orchestration, GitHub App integration, billing), see [wanman.ai](https://wanman.ai).

## What it does

- Coordinates multiple agents (CEO, dev, devops, marketing, feedback, etc.) through an async message bus with steer/follow-up priorities.
- Runs each agent as a real Claude Code or Codex CLI subprocess — you bring your own CLI auth, wanman orchestrates spawning, prompting, and lifecycle.
- Isolates every agent in a per-agent worktree and per-agent `$HOME`, so agents never mutate your dirty checkout or shell profile.
- Optionally executes the whole matrix inside a BoxLite microVM for stronger host isolation — one env var flip, same UX.
- Is CLI-first: everything is scriptable, observable, and reproducible through `wanman` commands and a JSON-RPC supervisor.

## Quickstart

```bash
# Prerequisites: Node 20+, pnpm 9+, git, a logged-in Claude Code or Codex CLI.
git clone <repo> wanman.dev
cd wanman.dev
pnpm install
pnpm build

# Point wanman at any git repo and hand it over to the agent matrix.
cd /path/to/any/git/repo
wanman takeover .
```

See [`docs/quickstart.md`](docs/quickstart.md) for the full walkthrough.

## CLI commands

| Command | What it does |
|---------|--------------|
| `wanman send <agent> <msg>` | Send a message to an agent (`--steer` interrupts the target). |
| `wanman recv [--agent <name>]` | Receive and mark pending messages as delivered. |
| `wanman agents` | List registered agents and their current states. |
| `wanman context get` / `context set` | Read or write shared key/value context. |
| `wanman escalate <msg>` | Escalate to the CEO agent. |
| `wanman task …` | Manage the task pool: `create`, `list`, `get`, `update`, `done`. Supports `--after` dependencies. |
| `wanman initiative …` | Manage long-lived initiatives: `create`, `list`, `get`, `update`. |
| `wanman capsule …` | Manage change capsules: `create`, `list`, `mine`, `get`, `update`. |
| `wanman artifact …` | Store and retrieve structured artifacts: `put`, `list`, `get`. |
| `wanman hypothesis …` | Track hypotheses with status transitions: `create`, `list`, `update`. |
| `wanman watch` | Live-stream supervisor and agent activity. |
| `wanman run <goal>` | Start a matrix against a one-shot goal (host only). |
| `wanman takeover <path>` | Take over an existing git repo with the full agent matrix (host only). |
| `wanman skill:check [path]` | Validate that skill docs reference only real CLI commands. |

Run `wanman --help` for the full, current list.

## Architecture

```
+----------------+          +--------------------+          +-----------------+
|  wanman CLI    |  JSON    |  Supervisor        |  spawn   |  Agent process  |
|  (host shell)  | ---RPC-->|  HTTP :3120        | -------> |  (Claude/Codex) |
|                |  /rpc    |  message/context/  |          |  per-agent $HOME|
|                |          |  task/artifact     |          |  per-agent wt   |
+----------------+          +--------------------+          +-----------------+
                                    |                              |
                                    | optional                     |
                                    v                              v
                           +--------------------+        +-----------------+
                           |  BoxLite microVM   |        |  worktree /     |
                           |  @sandbank.dev     |        |  brain (SQLite) |
                           +--------------------+        +-----------------+
```

- `wanman <subcommand>` speaks JSON-RPC 2.0 to a Supervisor process.
- The Supervisor owns the message store, context store, task pool, artifact store, and spawns one child process per agent.
- Each agent child is either a local Claude Code / Codex subprocess or, with BoxLite enabled, the same subprocess running inside a microVM bound to a per-agent worktree.

Deep dive: [`docs/architecture.md`](docs/architecture.md).

## Configuration

| Env var | Meaning |
|---------|---------|
| `WANMAN_URL` | Supervisor HTTP URL for the CLI (default `http://localhost:3120`). |
| `WANMAN_AGENT_NAME` | Identifies the current agent; used as default sender/receiver inside agent processes. |
| `WANMAN_WORKSPACE` | Override the agents workspace root (default `/workspace/agents` in container, `.wanman/agents` on host). |
| `WANMAN_RUNTIME` | `claude` (default) or `codex` — selects the per-agent CLI adapter. |
| `WANMAN_MODEL`, `WANMAN_CODEX_MODEL`, `WANMAN_CODEX_REASONING_EFFORT` | Per-runtime model overrides. |
| `WANMAN_SKILL_SNAPSHOTS_DIR` | Override where the runtime materializes skill-activation snapshots (default: sibling of the shared-skills dir, falling back to `$TMPDIR/wanman-skill-snapshots`). |
| `BOXLITE_PYTHON` | Path to the Python interpreter that hosts BoxLite (e.g. `/tmp/boxlite-venv/bin/python3`). |
| `BOXLITE_HOME` | Override BoxLite's state dir (default `~/.boxlite`). |
| `BOXLITE_API_URL` / `BOXLITE_API_TOKEN` | Point at a remote BoxLite server instead of the local daemon. |

An optional `@sandbank.dev/db9` brain can be attached for cross-run memory — see [`docs/architecture.md`](docs/architecture.md#brain--persistence).

## Agent configs

Agent definitions live in a single JSON file. A starter template is at [`apps/container/agents.example.json`](apps/container/agents.example.json):

```json
{
  "agents": [
    { "name": "echo", "lifecycle": "24/7", "model": "haiku", "systemPrompt": "..." },
    { "name": "ping", "lifecycle": "on-demand", "model": "haiku", "systemPrompt": "..." }
  ],
  "dbPath": "/data/wanman.db",
  "port": 3120,
  "workspaceRoot": "/workspace/agents"
}
```

Each agent entry has:
- `name` — unique identifier used on the message bus.
- `lifecycle` — `24/7` (continuous respawn loop) or `on-demand` (idle until triggered).
- `model` — passed through to the runtime adapter (Claude or Codex).
- `systemPrompt` — baked-in persona/mission; agents also auto-discover shared skill files at `~/.claude/skills/`.
- Optional `cron`, `events`, and `tools` fields — see the architecture doc for the full schema.

## Project structure

```
wanman.dev/
  apps/
    container/           Dockerfile + agents.example.json for sandboxed deploys
  packages/
    cli/                 wanman CLI (send/recv/task/artifact/run/takeover/...)
    core/                Shared types, JSON-RPC protocol, skills (core/skills/)
    host-sdk/            Host-side SDK for embedding wanman into other tools
    runtime/             Supervisor, agent process manager, SQLite stores, adapters
  docs/                  Architecture, quickstart, local-sandbox guides
```

Shared skills shipped today (`packages/core/skills/`):
- `artifact-naming`, `artifact-quality` — conventions for agent-produced artifacts.
- `cross-validation` — CEO consistency checks across agent outputs.
- `research-methodology` — market/data research methodology.
- `wanman-cli` — CLI command reference consumed by agents at runtime.
- `workspace-conventions` — file-system conventions inside agent workspaces.

## Further reading

- [Quickstart](docs/quickstart.md) — first-run walkthrough against any git repo.
- [Local sandbox (BoxLite)](docs/local-sandbox.md) — enabling microVM isolation.
- [Architecture](docs/architecture.md) — agent lifecycle, JSON-RPC, stores, adapters.
- [Contributing](CONTRIBUTING.md) — tests, typecheck, commit conventions.

## License

Apache-2.0 — see [LICENSE](LICENSE).
