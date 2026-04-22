/**
 * Unit tests for run command helpers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { detectProjectDir, parseOptions } from './run.js'
import { buildRunKickoffPayload } from '../execution-session.js'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: vi.fn() }
})

const mockExistsSync = vi.mocked(fs.existsSync)

describe('detectProjectDir', () => {
  const originalCwd = process.cwd
  const fakeCwd = '/tmp/my-novel-project'

  beforeEach(() => {
    process.cwd = () => fakeCwd
    mockExistsSync.mockReset()
  })

  afterEach(() => {
    process.cwd = originalCwd
  })

  it('returns cwd when agents.json exists', () => {
    mockExistsSync.mockReturnValue(true)

    const result = detectProjectDir()

    expect(result).toBe(fakeCwd)
    expect(mockExistsSync).toHaveBeenCalledWith(path.join(fakeCwd, 'agents.json'))
  })

  it('returns null when agents.json does not exist', () => {
    mockExistsSync.mockReturnValue(false)

    const result = detectProjectDir()

    expect(result).toBeNull()
    expect(mockExistsSync).toHaveBeenCalledWith(path.join(fakeCwd, 'agents.json'))
  })
})

describe('parseOptions', () => {
  it('should parse default options', () => {
    const { goal, opts } = parseOptions(['my goal'])
    expect(goal).toBe('my goal')
    expect(opts.loops).toBe(100)
    expect(opts.infinite).toBe(false)
    expect(opts.errorLimit).toBe(20)
  })

  it('should parse --infinite flag', () => {
    const { opts } = parseOptions(['my goal', '--infinite'])
    expect(opts.infinite).toBe(true)
    expect(opts.loops).toBe(Infinity)
  })

  it('should parse --error-limit', () => {
    const { opts } = parseOptions(['my goal', '--infinite', '--error-limit', '5'])
    expect(opts.infinite).toBe(true)
    expect(opts.errorLimit).toBe(5)
  })

  it('should parse --loops', () => {
    const { opts } = parseOptions(['my goal', '--loops', '50'])
    expect(opts.loops).toBe(50)
  })

  it('--infinite should override --loops', () => {
    const { opts } = parseOptions(['my goal', '--loops', '50', '--infinite'])
    expect(opts.infinite).toBe(true)
    expect(opts.loops).toBe(Infinity)
  })

  it('should parse --poll', () => {
    const { opts } = parseOptions(['my goal', '--poll', '30'])
    expect(opts.pollInterval).toBe(30)
  })

  it('should parse --runtime', () => {
    const { opts } = parseOptions(['my goal', '--runtime', 'codex'])
    expect(opts.runtime).toBe('codex')
  })

  it('should parse --codex-model', () => {
    const { opts } = parseOptions(['my goal', '--codex-model', 'gpt-5.4-mini'])
    expect(opts.codexModel).toBe('gpt-5.4-mini')
  })

  it('should parse --codex-effort', () => {
    const { opts } = parseOptions(['my goal', '--codex-effort', 'xhigh'])
    expect(opts.codexReasoningEffort).toBe('xhigh')
  })

  it('should parse --codex-speed aliases', () => {
    const { opts } = parseOptions(['my goal', '--codex-speed', 'balanced'])
    expect(opts.codexReasoningEffort).toBe('medium')
  })

  it('should parse --no-brain', () => {
    const { opts } = parseOptions(['my goal', '--no-brain'])
    expect(opts.noBrain).toBe(true)
  })

  it('should parse --keep', () => {
    const { opts } = parseOptions(['my goal', '--keep'])
    expect(opts.keep).toBe(true)
  })

  it('should parse --output', () => {
    const { opts } = parseOptions(['my goal', '--output', '/tmp/out'])
    expect(opts.output).toBe('/tmp/out')
  })

  it('should parse --project-dir', () => {
    const { opts } = parseOptions(['my goal', '--project-dir', '/tmp/my-project'])
    expect(opts.projectDir).toBe('/tmp/my-project')
  })

  it('should parse --config', () => {
    const { opts } = parseOptions(['my goal', '--config', './my-agents.json'])
    expect(opts.configPath).toBe('./my-agents.json')
  })

  it('should parse worker overrides', () => {
    const { opts } = parseOptions([
      'my goal',
      '--worker-url', 'http://127.0.0.1:1234',
      '--worker-model', 'local-model',
      '--worker-key', 'secret',
    ])
    expect(opts.workerUrl).toBe('http://127.0.0.1:1234')
    expect(opts.workerModel).toBe('local-model')
    expect(opts.workerKey).toBe('secret')
  })

  it('normalizes codex effort aliases and rejects invalid values', () => {
    expect(parseOptions(['my goal', '--codex-effort', 'deep']).opts.codexReasoningEffort).toBe('high')
    expect(parseOptions(['my goal', '--codex-speed', 'max']).opts.codexReasoningEffort).toBe('xhigh')
    expect(() => parseOptions(['my goal', '--codex-effort', 'invalid'])).toThrow(/Invalid codex effort/)
  })
})

describe('buildRunKickoffPayload', () => {
  it('tells CEO to create the initial backlog immediately', () => {
    const payload = buildRunKickoffPayload('Launch a blueberry farm in Azumino')
    expect(payload).toContain('Run kickoff for goal: Launch a blueberry farm in Azumino.')
    expect(payload).toContain('decompose the goal immediately')
    expect(payload).toContain('wanman task create')
    expect(payload).toContain('--path')
  })
})
