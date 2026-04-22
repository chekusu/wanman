import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildLocalSupervisorEnv,
  createHomeLayout,
  createLocalLogBuffer,
  installSharedSkills,
  resolveCliEntrypoint,
  resolveRuntimeEntrypoint,
  syncHomeEntry,
} from './local-supervisor.js'

describe('resolveCliEntrypoint', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'wanman-cli-entrypoint-'))
    tmpDirs.push(dir)
    return dir
  }

  it('uses dist/index.js when running from the built CLI directory', () => {
    const distDir = makeTmpDir()
    const entrypoint = path.join(distDir, 'index.js')
    fs.writeFileSync(entrypoint, '')

    expect(resolveCliEntrypoint(distDir, ['node'])).toBe(entrypoint)
  })

  it('uses ../dist/index.js when running from the source directory', () => {
    const packageDir = makeTmpDir()
    const srcDir = path.join(packageDir, 'src')
    const distDir = path.join(packageDir, 'dist')
    const entrypoint = path.join(distDir, 'index.js')
    fs.mkdirSync(srcDir)
    fs.mkdirSync(distDir)
    fs.writeFileSync(entrypoint, '')

    expect(resolveCliEntrypoint(srcDir, ['node'])).toBe(entrypoint)
  })

  it('falls back to the invoked CLI file for standalone bundles', () => {
    const bundleDir = makeTmpDir()
    const entrypoint = path.join(bundleDir, 'wanman.mjs')
    fs.writeFileSync(entrypoint, '')

    expect(resolveCliEntrypoint(bundleDir, ['node', entrypoint])).toBe(entrypoint)
  })

  it('throws when no CLI entrypoint candidate exists', () => {
    const emptyDir = makeTmpDir()

    expect(() => resolveCliEntrypoint(emptyDir, ['node'])).toThrow(/cannot find wanman CLI entrypoint/)
  })
})

describe('resolveRuntimeEntrypoint', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'wanman-runtime-entrypoint-'))
    tmpDirs.push(dir)
    return dir
  }

  it('resolves the monorepo runtime entrypoint from the CLI source directory', () => {
    const packageRoot = makeTmpDir()
    const cliSrc = path.join(packageRoot, 'packages', 'cli', 'src')
    const runtimeDist = path.join(packageRoot, 'packages', 'runtime', 'dist')
    const entrypoint = path.join(runtimeDist, 'entrypoint.js')
    fs.mkdirSync(cliSrc, { recursive: true })
    fs.mkdirSync(runtimeDist, { recursive: true })
    fs.writeFileSync(entrypoint, '')

    expect(resolveRuntimeEntrypoint(cliSrc)).toBe(entrypoint)
  })

  it('throws when no runtime entrypoint exists', () => {
    expect(() => resolveRuntimeEntrypoint(makeTmpDir())).toThrow(/cannot find runtime entrypoint/)
  })
})

describe('createLocalLogBuffer', () => {
  it('keeps complete non-empty lines and trims old retained lines', () => {
    const buffer = createLocalLogBuffer(2)

    buffer.pushChunk(' first line\n')
    buffer.pushChunk('second')
    buffer.pushChunk(' line\n\nthird line\n')

    expect(buffer.readSince(0)).toEqual({
      lines: ['second line', 'third line'],
      cursor: 3,
    })
    expect(buffer.readSince(2)).toEqual({
      lines: ['third line'],
      cursor: 3,
    })
    expect(buffer.readSince(99)).toEqual({
      lines: [],
      cursor: 3,
    })
  })
})

describe('local supervisor home layout helpers', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(tmpdir(), prefix))
    tmpDirs.push(dir)
    return dir
  }

  it('syncs host home entries as symlinks and replaces stale targets', () => {
    const sourceRoot = makeTmpDir('wanman-home-source-')
    const targetRoot = makeTmpDir('wanman-home-target-')
    const sourceDir = path.join(sourceRoot, '.ssh')
    const targetDir = path.join(targetRoot, '.ssh')
    fs.mkdirSync(sourceDir)
    fs.writeFileSync(path.join(sourceDir, 'config'), 'Host test\n')
    fs.mkdirSync(targetDir)
    fs.writeFileSync(path.join(targetDir, 'old'), 'old\n')

    syncHomeEntry(sourceDir, targetDir)

    expect(fs.lstatSync(targetDir).isSymbolicLink()).toBe(true)
    expect(fs.realpathSync(targetDir)).toBe(fs.realpathSync(sourceDir))
    expect(fs.existsSync(path.join(targetDir, 'config'))).toBe(true)
  })

  it('installs shared skills into Claude and Codex skill directories', () => {
    const sharedSkills = makeTmpDir('wanman-shared-skills-')
    const agentHome = makeTmpDir('wanman-agent-home-')
    fs.mkdirSync(path.join(sharedSkills, 'takeover-context'))
    fs.writeFileSync(path.join(sharedSkills, 'takeover-context', 'SKILL.md'), '# Takeover\n')
    fs.writeFileSync(path.join(sharedSkills, 'ignored.txt'), 'not a skill\n')

    installSharedSkills(sharedSkills, agentHome)

    expect(fs.readFileSync(path.join(agentHome, '.claude', 'skills', 'takeover-context', 'SKILL.md'), 'utf-8')).toBe('# Takeover\n')
    expect(fs.readFileSync(path.join(agentHome, '.codex', 'skills', 'takeover-context', 'SKILL.md'), 'utf-8')).toBe('# Takeover\n')
  })

  it('creates wrappers and links selected host home entries', () => {
    const hostHome = makeTmpDir('wanman-host-home-')
    const homeRoot = makeTmpDir('wanman-home-layout-')
    const cliEntrypoint = path.join(homeRoot, 'host-cli.js')
    fs.writeFileSync(cliEntrypoint, '')
    fs.mkdirSync(path.join(hostHome, '.config'))

    const layout = createHomeLayout(homeRoot, {
      home: hostHome,
      cliHostEntrypoint: cliEntrypoint,
    })

    const wanmanWrapper = path.join(layout.binDir, 'wanman')
    expect(fs.readFileSync(wanmanWrapper, 'utf-8')).toContain(JSON.stringify(cliEntrypoint))
    expect(fs.statSync(wanmanWrapper).mode & 0o111).toBeGreaterThan(0)
    expect(fs.lstatSync(path.join(layout.agentHome, '.config')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(layout.agentHome, '.bash_profile'), 'utf-8')).toContain(layout.binDir)
  })
})

describe('buildLocalSupervisorEnv', () => {
  it('sets local supervisor paths and strips outer Codex session controls', () => {
    const env = buildLocalSupervisorEnv({
      PATH: '/usr/bin',
      CODEX_CI: '1',
      CODEX_SANDBOX_NETWORK_DISABLED: '1',
      CODEX_THREAD_ID: 'thread',
      KEEP: 'yes',
    }, {
      configPath: '/tmp/agents.json',
      workspaceRoot: '/tmp/agents',
      gitRoot: '/tmp/repo',
      sharedSkillsDir: '/tmp/skills',
      homeRoot: '/tmp/home-root',
      goal: 'ship',
      runtime: 'codex',
      codexModel: 'gpt-test',
      codexReasoningEffort: 'high',
    }, '/tmp/home', '/tmp/bin', 3333)

    expect(env['HOME']).toBe('/tmp/home')
    expect(env['PATH']).toBe('/tmp/bin:/usr/bin')
    expect(env['WANMAN_URL']).toBe('http://127.0.0.1:3333')
    expect(env['WANMAN_CONFIG']).toBe('/tmp/agents.json')
    expect(env['WANMAN_GIT_ROOT']).toBe('/tmp/repo')
    expect(env['WANMAN_GOAL']).toBe('ship')
    expect(env['WANMAN_RUNTIME']).toBe('codex')
    expect(env['WANMAN_CODEX_MODEL']).toBe('gpt-test')
    expect(env['WANMAN_CODEX_REASONING_EFFORT']).toBe('high')
    expect(env['KEEP']).toBe('yes')
    expect(env['CODEX_CI']).toBeUndefined()
    expect(env['CODEX_SANDBOX_NETWORK_DISABLED']).toBeUndefined()
    expect(env['CODEX_THREAD_ID']).toBeUndefined()
  })
})
