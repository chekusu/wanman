# Changelog

All notable changes to this project will be documented in this file.

This initial entry is a baseline for the current open-source `0.1.0` release state. Earlier development was not tracked in a public changelog, so the notes below summarize the shipped surface area that exists in the repository today.

## [0.1.0] - 2026-06-25

### Added

- `@wanman/cli`, a JSON-RPC command-line interface for agent messaging, shared context, task management, initiatives, change capsules, artifacts, hypotheses, `watch`, `run`, `takeover`, and `skill:check`.
- `@wanman/runtime`, the local supervisor that owns SQLite-backed state, cron and external-event routing, agent process management, and Claude/Codex runtime adapters.
- `@wanman/core`, which ships the shared protocol/types layer and the runtime-distributed skill bundle used by agents.
- `@wanman/host-sdk`, a host-side SDK surface for embedding wanman into other tools.
- Local takeover flow that snapshots a target git repository into `.wanman/worktree/`, keeps agents on isolated per-agent `$HOME` directories, and routes collaboration through the supervisor.
- Agent lifecycle support for continuous `24/7`, stateless `on-demand`, and Claude-only `idle_cached` execution modes.
- Mission-control storage for tasks, initiatives, change capsules, artifacts, hypotheses, and shared context/messages.
- Optional `@sandbank.dev/db9` brain integration for cross-run memory mirroring.
- Experimental `@wanman/finops` package and `wanman-finops` CLI for API credential inventory, provider cost sync, Stripe revenue sync, and ROI review workflows.
- Public quickstart, architecture, and FinOps documentation for operating the OSS runtime from source.

### Notes

- This is the first public changelog entry. Future entries should capture incremental changes instead of restating the full repository baseline.
