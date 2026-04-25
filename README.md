# wanman

**English** | [中文](README.zh.md) | [日本語](README.ja.md)

Agent Matrix framework — run a supervised network of Claude Code or Codex agents that collaborate on your machine.

wanman is an open-source local-mode agent matrix framework. Runs a supervised network of Claude Code or Codex agents on your machine, coordinated through a JSON-RPC supervisor.

## About wanman

The name wanman comes from the Japanese [ワンマン電車 / one-man train](https://en.wikipedia.org/wiki/One-person_operation): a train operated by one driver without a conductor. wanman's design goal is similar in spirit: the human user steps back into an observer role and watches the agent matrix run automatically from every angle.

[wanman.ai](https://wanman.ai/) provides the fully automated 24/7 sandbox edition of wanman, running for free on [Sandbank Cloud](https://cloud.sandbank.dev/)'s sandbox cloud.

## What it does

- Coordinates multiple agents (CEO, dev, devops, marketing, feedback, etc.) through an async message bus with steer/follow-up priorities.
- Runs each agent as a real Claude Code or Codex CLI subprocess — you bring your own CLI auth, wanman orchestrates spawning, prompting, and lifecycle.
- Isolates every agent in a per-agent worktree and per-agent `$HOME`, so agents never mutate your dirty checkout or shell profile.
- Is CLI-first: everything is scriptable, observable, and reproducible through `wanman` commands and a JSON-RPC supervisor.

[wanman.ai](https://wanman.ai/) adds hosted-only capabilities:
- Isolates each agent runtime group in its own sandbox environment, supporting large-scale, high-concurrency task execution.
- Dynamically configures agent roles, including automatically extracting roles from high-quality agent role catalogs on the internet.
- Supports dynamic skill self-evolution.
- Supports db9-powered global search and story retrieval.

## Quickstart

```bash
# Prerequisites: Node 20+, pnpm 9+, git, a logged-in Claude Code or Codex CLI.
git clone git@github.com:chekusu/wanman.git wanman.dev
cd wanman.dev
pnpm install
pnpm build

# Run from source; no npm package publish is required.
pnpm --filter @wanman/cli exec wanman takeover /path/to/any/git/repo
```

If you want a single-file CLI bundle instead:

```bash
pnpm --filter @wanman/cli standalone
node packages/cli/dist/wanman.mjs takeover /path/to/any/git/repo
```

If `wanman` is already on your `PATH`, you can also run `wanman takeover .` from inside the target repository.

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
| `wanman run <goal>` | Start a matrix against a one-shot goal. |
| `wanman takeover <path>` | Take over an existing git repo with the full agent matrix. |
| `wanman skill:check [path]` | Validate that skill docs reference only real CLI commands. |

Run `wanman --help` for the full, current list.

## Architecture

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

- `wanman <subcommand>` speaks JSON-RPC 2.0 to a Supervisor process.
- The Supervisor owns the message store, context store, task pool, artifact store, and spawns one child process per agent.
- Each agent child is a local Claude Code or Codex subprocess bound to a per-agent worktree and isolated `$HOME`.

Deep dive: [`docs/architecture.md`](docs/architecture.md).

## Configuration

| Env var | Meaning |
|---------|---------|
| `WANMAN_URL` | Supervisor HTTP URL for the CLI (default `http://localhost:3120`). |
| `WANMAN_AGENT_NAME` | Identifies the current agent; used as default sender/receiver inside agent processes. |
| `WANMAN_RUNTIME` | `claude` (default) or `codex` — selects the per-agent CLI adapter. |
| `WANMAN_MODEL`, `WANMAN_CODEX_MODEL`, `WANMAN_CODEX_REASONING_EFFORT` | Per-runtime model overrides. |
| `WANMAN_CODEX_FAST` | When set, biases the Codex adapter toward lower-latency defaults. |
| `WANMAN_SKILL_SNAPSHOTS_DIR` | Override where the runtime materializes skill-activation snapshots (default: sibling of the shared-skills dir, falling back to `$TMPDIR/wanman-skill-snapshots`). |

An optional `@sandbank.dev/db9` brain adapter can be attached for cross-run memory — see [`docs/architecture.md`](docs/architecture.md#brain--persistence).

## Agent configs

Agent definitions live in a single JSON file:

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

Each agent entry has:
- `name` — unique identifier used on the message bus.
- `lifecycle` — `24/7` (continuous respawn loop), `on-demand` (idle until triggered), or `idle_cached` (idle until triggered, but the prior Claude `session_id` is preserved across triggers via `claude --resume` so context survives idle periods). **`idle_cached` is Claude-only**: pairing it with `runtime: codex` (or `WANMAN_RUNTIME=codex`) is rejected at startup since Codex has no equivalent resume mechanism in this runtime.
- `model` — usually an abstract tier (`high` or `standard`); the runtime adapter maps it to Claude or Codex defaults, with environment overrides available.
- `systemPrompt` — baked-in persona/mission; agents also auto-discover shared skill files at `~/.claude/skills/`.
- Optional `cron`, `events`, and `tools` fields — see the architecture doc for the full schema.

## Testing

```bash
pnpm typecheck
pnpm test
pnpm exec vitest run --coverage --coverage.reporter=text-summary --coverage.reporter=json-summary --coverage.exclude='**/dist/**'
```

The current coverage target is at least 90% line coverage. The latest verified local run reports `Lines: 90.17%`; the machine-readable summary is written to `coverage/coverage-summary.json`.

## Project structure

```
wanman.dev/
  packages/
    cli/                 wanman CLI (send/recv/task/artifact/run/takeover/...)
    core/                Shared types, JSON-RPC protocol, skills (core/skills/)
    host-sdk/            Host-side SDK for embedding wanman into other tools
    runtime/             Supervisor, agent process manager, SQLite stores, adapters
  docs/                  Architecture and quickstart guides
```

Shared skills shipped today (`packages/core/skills/`):
- `artifact-naming`, `artifact-quality` — conventions for agent-produced artifacts.
- `cross-validation` — CEO consistency checks across agent outputs.
- `research-methodology` — market/data research methodology.
- `wanman-cli` — CLI command reference consumed by agents at runtime.
- `workspace-conventions` — file-system conventions inside agent workspaces.

## Further reading

- [Quickstart](docs/quickstart.md) — first-run walkthrough against any git repo.
- [Architecture](docs/architecture.md) — agent lifecycle, JSON-RPC, stores, adapters.
- [Contributing](CONTRIBUTING.md) — tests, typecheck, commit conventions.

## License

Apache-2.0 — see [LICENSE](LICENSE).
