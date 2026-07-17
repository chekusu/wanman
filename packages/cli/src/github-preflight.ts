import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export interface GitHubPreflightResult {
  repository?: string
  failures: string[]
}

type CommandRunner = (command: string) => string

function defaultRunner(command: string, token: string): string {
  return execSync(command, {
    encoding: 'utf-8',
    env: { ...process.env, GH_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    shell: '/bin/bash',
  }).trim()
}

function errorOutput(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const stderr = 'stderr' in error ? String(error.stderr) : ''
  return `${error.message}\n${stderr}`
}

function isExpectedPullRequestValidationFailure(error: unknown): boolean {
  const output = errorOutput(error)
  return /\bHTTP 422\b/i.test(output)
}

export function parseGitHubRepository(remote?: string): string | undefined {
  if (!remote) return undefined
  const match = remote.trim().match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i)
  if (!match) return undefined
  return `${match[1]}/${match[2]}`
}

/**
 * Run non-mutating GitHub checks before takeover agents start.
 *
 * The pull-request write check deliberately submits an invalid same-branch
 * request. A 422 response proves the credential passed endpoint authorization
 * without creating a pull request.
 */
export function checkGitHubPreflight(
  remote?: string,
  token?: string,
  run?: CommandRunner,
): GitHubPreflightResult {
  const repository = parseGitHubRepository(remote)
  if (!repository) return { failures: [] }

  if (!token) {
    return {
      repository,
      failures: [
        'GitHub authentication is unavailable. Run `gh auth login -h github.com` or export `GH_TOKEN` before takeover.',
      ],
    }
  }

  const runWithToken = (command: string): string => {
    if (!run) return defaultRunner(command, token)
    return run(command)
  }

  try {
    runWithToken('command -v gh')
  } catch {
    return {
      repository,
      failures: ['GitHub CLI `gh` is not installed; install it before running takeover against GitHub.'],
    }
  }

  const failures: string[] = []
  try {
    runWithToken(`gh api repos/${repository} --jq .full_name`)
  } catch {
    failures.push(`Cannot read repository metadata for ${repository}; confirm the repository is accessible to the agent credential.`)
  }

  try {
    const canPush = runWithToken(`gh api repos/${repository} --jq '.permissions.push // .permissions.admin // false'`)
    if (canPush !== 'true') {
      failures.push(`GitHub credential cannot push to ${repository}; grant Contents: write (or equivalent repository write access).`)
    }
  } catch {
    failures.push(`Unable to verify Contents: write capability for ${repository}.`)
  }

  try {
    runWithToken(`gh pr list --repo ${repository} --limit 1 --json number`)
  } catch {
    failures.push(`Cannot read pull requests for ${repository}; grant Pull requests: read/write.`)
  }

  // GitHub has no universal read-only endpoint that reports PR-write access for
  // OAuth, fine-grained PAT, and installation tokens. Exercise the create-PR
  // authorization path with the same nonexistent branch as both head and base.
  // GitHub returns 422 after authorization and cannot create a PR from a branch
  // to itself, so this verifies write access without creating repository state.
  const missingBranch = `wanman-preflight-${randomUUID()}-missing`
  try {
    runWithToken([
      `gh api --method POST repos/${repository}/pulls`,
      '-f title=wanman-permission-preflight',
      `-f head=${missingBranch}`,
      `-f base=${missingBranch}`,
    ].join(' '))
    failures.push(`Pull-request write probe for ${repository} returned an unexpected success; no PR should be creatable from a branch to itself.`)
  } catch (error) {
    if (!isExpectedPullRequestValidationFailure(error)) {
      failures.push(`Cannot create pull requests in ${repository}; grant Pull requests: write.`)
    }
  }

  try {
    runWithToken(`gh run list --repo ${repository} --limit 1 --json databaseId`)
  } catch {
    failures.push(`Cannot read GitHub Actions runs for ${repository}; grant Actions: read.`)
  }

  return { repository, failures }
}

export function assertGitHubPreflight(remote?: string, token?: string, run?: CommandRunner): void {
  const result = checkGitHubPreflight(remote, token, run)
  if (!result.repository) return

  if (result.failures.length === 0) {
    console.log(`  [local] GitHub preflight passed for ${result.repository}`)
    return
  }

  throw new Error([
    `GitHub preflight failed for ${result.repository}:`,
    ...result.failures.map(failure => `  - ${failure}`),
    'Agents were not started. Repair the credential permissions and run takeover again.',
  ].join('\n'))
}
