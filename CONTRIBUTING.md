# Contributing to wanman

Thanks for hacking on wanman. This repo is a pnpm + Turborepo TypeScript monorepo targeting Node 20+.

## Prerequisites

- Node.js 20 or newer.
- pnpm 9 or newer (`corepack enable && corepack prepare pnpm@9.15.0 --activate`).
- Git.

## Workspace commands

```bash
pnpm install      # install all workspace deps
pnpm build        # turbo-build every package (dist/)
pnpm typecheck    # tsc --noEmit across the workspace
pnpm test         # vitest run across the workspace
pnpm clean        # wipe turbo cache + node_modules
```

Turbo caches results per-package, so re-running `pnpm build` or `pnpm test` after a small change is cheap.

## Per-package development

Work inside a single package when iterating:

```bash
pnpm --filter @wanman/cli test
pnpm --filter @wanman/cli typecheck
pnpm --filter @wanman/cli build

pnpm --filter @wanman/runtime test
pnpm --filter @wanman/core test
pnpm --filter @wanman/host-sdk build
```

Vitest watch mode:

```bash
pnpm --filter @wanman/runtime exec vitest
```

## Tests required for new code

New features and bug fixes must ship with tests. Follow TDD where feasible:
1. Write a failing test that pins the desired behavior.
2. Implement the minimum change needed to make it pass.
3. Refactor with tests green.

Do not land features without coverage. If a piece of behavior is genuinely untestable (e.g. requires a real Claude API key, third-party TTY, etc.), call it out explicitly in the PR description and add an integration test skeleton that can be enabled later.

## Code style

- TypeScript 5.7, ESM everywhere (`"type": "module"`).
- 2-space indentation, single quotes, semicolons consistent with surrounding code.
- Prefer named exports; reserve default exports for entrypoint-style files.
- Keep functions small and intention-revealing. Match the existing patterns in the package you are editing rather than inventing new ones.
- No `any` without a comment explaining why.

Run `pnpm typecheck` before pushing.

## Commit message conventions

Commit messages follow a lightweight conventional-commits style used throughout the repo:

```
<type>(<scope>): <short imperative summary>
```

Where `<type>` is one of:

| Type | Use for |
|------|---------|
| `feat` | New user-visible capability. |
| `fix` | Bug fix. |
| `refactor` | Internal restructuring with no behavior change. |
| `test` | Test-only changes. |
| `docs` | Documentation changes. |
| `chore` | Tooling, deps, housekeeping. |

And `<scope>` is the package or area touched: `cli`, `runtime`, `core`, `host-sdk`, `container`, `skills`. Multiple scopes are comma-separated, e.g. `fix(runtime,cli): ...`.

Examples from the repo history:

```
feat(container): reference Dockerfile + echo/ping example agents
fix(runtime): make skill-snapshots path configurable
refactor(cli): strip control-plane commands, Daytona adapter
test(runtime): drop SaaS-only production-agents imports
chore(skills): drop wanman-specific skills, keep generic ones
docs: README, quickstart, local-sandbox, architecture, contributing
```

Keep the summary under ~72 characters. Use the body for context, motivation, and links.

## Filing issues and pull requests

- Issues and PRs are tracked on the project's GitHub repository. (Repo URL will be published with the first tagged release; until then, coordinate with the maintainers.)
- For bugs, include: reproduction steps, expected vs actual behavior, wanman version (commit SHA), Node version, and relevant env vars (`WANMAN_RUNTIME`, `BOXLITE_*`).
- For PRs, describe the motivation, list the files touched, and link the issue if one exists.

## License

By contributing you agree that your contributions will be licensed under Apache-2.0, matching the [LICENSE](LICENSE) of this repo.
