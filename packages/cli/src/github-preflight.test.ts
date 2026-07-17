import { describe, expect, it, vi } from 'vitest'
import { assertGitHubPreflight, checkGitHubPreflight, parseGitHubRepository } from './github-preflight.js'

describe('parseGitHubRepository', () => {
  it.each([
    ['https://github.com/acme/app.git', 'acme/app'],
    ['git@github.com:acme/app.git', 'acme/app'],
    ['ssh://git@github.com/acme/app', 'acme/app'],
  ])('parses %s', (remote, expected) => {
    expect(parseGitHubRepository(remote)).toBe(expected)
  })

  it('ignores non-GitHub remotes', () => {
    expect(parseGitHubRepository('https://gitlab.com/acme/app.git')).toBeUndefined()
  })
})

describe('checkGitHubPreflight', () => {
  it('passes when auth, push, PR, and Actions checks succeed', () => {
    const run = vi.fn((command: string) => {
      if (command.includes('.permissions.push')) return 'true'
      if (command.includes('--method POST')) throw new Error('HTTP 422: Validation Failed')
      return 'ok'
    })

    expect(checkGitHubPreflight('https://github.com/acme/app.git', 'agent-token', run)).toEqual({
      repository: 'acme/app',
      failures: [],
    })
  })

  it('reports missing agent authentication before attempting repository checks', () => {
    const run = vi.fn(() => 'ok')

    const result = checkGitHubPreflight('git@github.com:acme/app.git', undefined, run)
    expect(result.failures).toEqual([expect.stringContaining('gh auth login')])
    expect(run).not.toHaveBeenCalled()
  })

  it('reports missing push, PR read/write, and Actions capabilities', () => {
    const run = vi.fn((command: string) => {
      if (command.includes('.permissions.push')) return 'false'
      if (command.startsWith('gh pr list')) throw new Error('forbidden')
      if (command.includes('--method POST')) throw new Error('HTTP 403: Resource not accessible by integration')
      if (command.startsWith('gh run list')) throw new Error('forbidden')
      return 'ok'
    })

    const result = checkGitHubPreflight('https://github.com/acme/app', 'agent-token', run)
    expect(result.failures).toEqual([
      expect.stringContaining('Contents: write'),
      expect.stringContaining('read pull requests'),
      expect.stringContaining('Pull requests: write'),
      expect.stringContaining('Actions: read'),
    ])
  })

  it('reports repository metadata failures', () => {
    const run = vi.fn((command: string) => {
      if (command.includes('--jq .full_name')) throw new Error('not found')
      if (command.includes('.permissions.push')) return 'true'
      if (command.includes('--method POST')) throw new Error('HTTP 422: Validation Failed')
      return 'ok'
    })

    expect(checkGitHubPreflight('https://github.com/acme/app', 'agent-token', run).failures)
      .toEqual([expect.stringContaining('metadata')])
  })
})

describe('assertGitHubPreflight', () => {
  it('prints a clear successful preflight', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const run = vi.fn((command: string) => {
      if (command.includes('.permissions.push')) return 'true'
      if (command.includes('--method POST')) throw new Error('HTTP 422: Validation Failed')
      return 'ok'
    })

    assertGitHubPreflight('https://github.com/acme/app.git', 'agent-token', run)

    expect(log).toHaveBeenCalledWith('  [local] GitHub preflight passed for acme/app')
    log.mockRestore()
  })

  it('fails before startup with concrete remediation', () => {
    expect(() => assertGitHubPreflight('https://github.com/acme/app.git', undefined))
      .toThrow(/Agents were not started[\s\S]*Repair the credential permissions/)
  })
})
