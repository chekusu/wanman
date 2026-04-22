import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDefaultLocalRunConfigText,
  downloadLocalDeliverables,
  downloadLocalRepoPatch,
  findProjectRoot,
  getSelectedConfigText,
  isStale,
  loadEnvFile,
  localizeRunConfigForHost,
  materializeLocalRunLayout,
  resolveSelectedConfigName,
  type EmbeddedAssets,
} from './execution-session.js'

const originalCwd = process.cwd()
const tmpDirs: string[] = []

afterEach(() => {
  process.chdir(originalCwd)
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

describe('localizeRunConfigForHost', () => {
  it('rewrites config paths to the host run layout', () => {
    const configText = JSON.stringify({
      agents: [{ name: 'ceo', lifecycle: '24/7', model: 'claude-opus-4-6', systemPrompt: 'CEO' }],
      dbPath: '/workspace/wanman.db',
      workspaceRoot: '/workspace/agents',
    })

    const result = JSON.parse(localizeRunConfigForHost(
      configText,
      '/tmp/local-run',
      '/tmp/local-run/agents',
      '/tmp/project',
    )) as { dbPath: string; workspaceRoot: string; gitRoot: string }

    expect(result.dbPath).toBe('/tmp/local-run/wanman.db')
    expect(result.workspaceRoot).toBe('/tmp/local-run/agents')
    expect(result.gitRoot).toBe('/tmp/project')
  })
})

describe('execution-session host helpers', () => {
  it('loads .env values without overriding existing environment keys', () => {
    const root = makeTmpDir('wanman-env-')
    fs.writeFileSync(path.join(root, '.env'), [
      '# comment',
      'DB9_TOKEN="from-file"',
      'EMPTY',
      'EXISTING=from-file',
      "QUOTED='value with spaces'",
      '',
    ].join('\n'))
    const env: NodeJS.ProcessEnv = { EXISTING: 'keep-me' }

    loadEnvFile(root, env)

    expect(env['DB9_TOKEN']).toBe('from-file')
    expect(env['EXISTING']).toBe('keep-me')
    expect(env['QUOTED']).toBe('value with spaces')
  })

  it('finds a pnpm workspace root by walking up from cwd', () => {
    const root = makeTmpDir('wanman-root-')
    const nested = path.join(root, 'a', 'b')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
    process.chdir(nested)

    expect(fs.realpathSync(findProjectRoot()!)).toBe(fs.realpathSync(root))

    const isolated = makeTmpDir('wanman-no-root-')
    process.chdir(isolated)
    expect(findProjectRoot()).toBeNull()
  })

  it('detects stale dist output from missing or newer source files', () => {
    const root = makeTmpDir('wanman-stale-')
    const src = path.join(root, 'src')
    const dist = path.join(root, 'dist.js')
    fs.mkdirSync(src)

    expect(isStale(dist, src)).toBe(true)

    fs.writeFileSync(dist, '')
    fs.writeFileSync(path.join(src, 'index.ts'), '')
    const old = new Date(Date.now() - 10_000)
    const now = new Date()
    fs.utimesSync(dist, old, old)
    fs.utimesSync(path.join(src, 'index.ts'), now, now)
    expect(isStale(dist, src)).toBe(true)

    fs.utimesSync(dist, now, now)
    fs.utimesSync(path.join(src, 'index.ts'), old, old)
    expect(isStale(dist, src)).toBe(false)
  })
})

describe('materializeLocalRunLayout', () => {
  const configText = JSON.stringify({
    agents: [
      { name: 'ceo', lifecycle: '24/7', model: 'high', systemPrompt: 'CEO system' },
      { name: 'dev', lifecycle: 'on-demand', model: 'standard', systemPrompt: 'Dev system' },
    ],
    port: 3120,
  })

  it('writes embedded agent guides and shared skills for standalone local runs', () => {
    const outputDir = makeTmpDir('wanman-layout-output-')
    const embedded: EmbeddedAssets = {
      ENTRYPOINT_JS: '',
      CLI_JS: '',
      AGENT_CONFIGS: {},
      AGENT_SKILLS: { ceo: '# Embedded CEO\n' },
      SHARED_SKILLS: { 'takeover-context': '# Shared Skill\n' },
      PRODUCTS_JSON: null,
    }

    const layout = materializeLocalRunLayout({
      runId: 'run-test',
      outputDir,
      embedded,
      configText,
      gitRoot: '/tmp/repo',
    })

    expect(JSON.parse(fs.readFileSync(layout.configPath, 'utf-8')).gitRoot).toBe('/tmp/repo')
    expect(fs.readFileSync(path.join(layout.workspaceRoot, 'ceo', 'AGENT.md'), 'utf-8')).toBe('# Embedded CEO\n')
    expect(fs.readFileSync(path.join(layout.workspaceRoot, 'dev', 'AGENT.md'), 'utf-8')).toContain('Operating Rules')
    expect(fs.readFileSync(path.join(layout.sharedSkillsDir, 'takeover-context', 'SKILL.md'), 'utf-8')).toBe('# Shared Skill\n')

    layout.cleanup()
    expect(fs.existsSync(layout.baseDir)).toBe(false)
  })

  it('combines project agents, embedded shared skills, and project skills', () => {
    const outputDir = makeTmpDir('wanman-layout-project-output-')
    const projectDir = makeTmpDir('wanman-project-')
    fs.mkdirSync(path.join(projectDir, 'agents', 'dev'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'agents', 'dev', 'AGENT.md'), '# Project Dev\n')
    fs.mkdirSync(path.join(projectDir, 'skills', 'project-skill'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'skills', 'project-skill', 'SKILL.md'), '# Project Skill\n')
    const embedded: EmbeddedAssets = {
      ENTRYPOINT_JS: '',
      CLI_JS: '',
      AGENT_CONFIGS: {},
      AGENT_SKILLS: {},
      SHARED_SKILLS: { embedded: '# Embedded Skill\n' },
      PRODUCTS_JSON: null,
    }

    const layout = materializeLocalRunLayout({
      runId: 'run-project',
      outputDir,
      projectDir,
      embedded,
      configText,
    })

    expect(fs.readFileSync(path.join(layout.workspaceRoot, 'dev', 'AGENT.md'), 'utf-8')).toBe('# Project Dev\n')
    expect(fs.readFileSync(path.join(layout.sharedSkillsDir, 'embedded', 'SKILL.md'), 'utf-8')).toBe('# Embedded Skill\n')
    expect(fs.readFileSync(path.join(layout.sharedSkillsDir, 'project-skill', 'SKILL.md'), 'utf-8')).toBe('# Project Skill\n')
  })
})

describe('default local run config', () => {
  it('creates a built-in local config when no project config is supplied', () => {
    const config = JSON.parse(createDefaultLocalRunConfigText({
      loops: 1,
      pollInterval: 1,
      output: './deliverables',
      keep: false,
      noBrain: true,
      infinite: false,
      errorLimit: 20,
      workerKey: 'lmstudio',
    })) as { agents: Array<{ name: string; runtime?: string; model: string; baseUrl?: string }> }

    expect(config.agents.map(agent => agent.name)).toEqual(['ceo', 'dev', 'feedback'])
    expect(config.agents.every(agent => agent.runtime === undefined)).toBe(true)
    expect(config.agents.map(agent => agent.model)).toEqual(['high', 'standard', 'standard'])
  })

  it('honors codex and worker overrides in the built-in local config', () => {
    const config = JSON.parse(createDefaultLocalRunConfigText({
      loops: 1,
      pollInterval: 1,
      output: './deliverables',
      keep: false,
      noBrain: true,
      infinite: false,
      errorLimit: 20,
      workerKey: 'lmstudio',
      runtime: 'codex',
      codexModel: 'gpt-test',
      workerUrl: 'http://127.0.0.1:1234',
      workerModel: 'local-worker',
    })) as { agents: Array<{ name: string; runtime?: string; model: string; baseUrl?: string }> }

    const ceo = config.agents.find(agent => agent.name === 'ceo')!
    const dev = config.agents.find(agent => agent.name === 'dev')!
    expect(ceo.runtime).toBe('codex')
    expect(ceo.model).toBe('high')
    expect(dev.runtime).toBe('claude')
    expect(dev.model).toBe('local-worker')
    expect(dev.baseUrl).toBe('http://127.0.0.1:1234')
  })

  it('uses the built-in local config name and text by default', () => {
    const opts = {
      loops: 1,
      pollInterval: 1,
      output: './deliverables',
      keep: false,
      noBrain: true,
      infinite: false,
      errorLimit: 20,
      workerKey: 'lmstudio',
    }

    expect(resolveSelectedConfigName(undefined, opts)).toBe('built-in-local-agents.json')
    expect(JSON.parse(getSelectedConfigText(undefined, opts)).agents).toHaveLength(3)
  })

  it('selects explicit config files and project config files before the built-in default', () => {
    const root = makeTmpDir('wanman-config-select-')
    const projectDir = path.join(root, 'project')
    const customConfig = path.join(root, 'custom-agents.json')
    fs.mkdirSync(projectDir)
    fs.writeFileSync(customConfig, '{"agents":[{"name":"custom"}]}')
    fs.writeFileSync(path.join(projectDir, 'agents.json'), '{"agents":[{"name":"project"}]}')
    const opts = {
      loops: 1,
      pollInterval: 1,
      output: './deliverables',
      keep: false,
      noBrain: true,
      infinite: false,
      errorLimit: 20,
      configPath: customConfig,
    }

    expect(resolveSelectedConfigName(projectDir, opts)).toBe('custom-agents.json')
    expect(JSON.parse(getSelectedConfigText(projectDir, opts)).agents[0].name).toBe('custom')
    expect(resolveSelectedConfigName(projectDir, { ...opts, configPath: undefined })).toBe('agents.json (project)')
    expect(JSON.parse(getSelectedConfigText(projectDir, { ...opts, configPath: undefined })).agents[0].name).toBe('project')
  })
})

describe('local run downloads', () => {
  it('skips deliverable export when the workspace has no files', async () => {
    const output = makeTmpDir('wanman-empty-export-')
    const workspace = path.join(output, 'workspace')
    fs.mkdirSync(workspace)

    await downloadLocalDeliverables({ listTasks: async () => [] } as never, output, workspace)

    expect(fs.readdirSync(output)).toEqual(['workspace'])
  })

  it('skips repo patch export when the git worktree is clean', async () => {
    const output = makeTmpDir('wanman-clean-patch-')
    const repo = makeTmpDir('wanman-clean-repo-')
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })

    await downloadLocalRepoPatch(output, repo)

    const runDirs = fs.readdirSync(output)
    expect(runDirs).toHaveLength(1)
    expect(fs.existsSync(path.join(output, runDirs[0]!, 'repo.patch'))).toBe(false)
  })
})
