import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import {
  detectLanguages,
  detectPackageManagers,
  detectFrameworks,
  detectCI,
  detectTests,
  detectCodeRoots,
  detectPackageScripts,
  collectProjectDocs,
  buildProjectIntent,
  scanReadme,
  scanProject,
  generateAgentConfig,
  inferGoal,
  hasLocalProgress,
  materializeLocalTakeoverProject,
  materializeTakeoverProject,
  parseLocalGitStatus,
  planLocalDynamicClone,
  takeoverCommand,
  type ProjectProfile,
} from './takeover.js'

let tmpDir: string

function makeProfile(overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    path: tmpDir,
    languages: ['typescript', 'javascript'],
    packageManagers: ['pnpm'],
    frameworks: ['react'],
    ci: ['github-actions'],
    testFrameworks: ['vitest'],
    hasReadme: true,
    hasClaudeMd: false,
    hasDocs: true,
    issueTracker: 'github',
    githubRemote: 'git@github.com:test/repo.git',
    readmeExcerpt: '# Test',
    codeRoots: ['src'],
    packageScripts: ['build', 'test'],
    ...overrides,
  }
}

function makeLocalObservationState(
  overrides: Partial<Parameters<typeof hasLocalProgress>[0]> = {},
): Parameters<typeof hasLocalProgress>[0] {
  return {
    health: { agents: [] },
    tasks: [],
    initiatives: [],
    capsules: [],
    artifacts: [],
    logs: [],
    branchAhead: 0,
    hasUpstream: false,
    modifiedFiles: [],
    ...overrides,
  }
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `takeover-test-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true }) } catch { /* ignore */ }
})

function touch(relativePath: string, content = ''): void {
  const fullPath = join(tmpDir, relativePath)
  mkdirSync(join(fullPath, '..'), { recursive: true })
  writeFileSync(fullPath, content)
}

describe('detectLanguages', () => {
  it('should detect TypeScript with tsconfig.json', () => {
    touch('package.json', '{}')
    touch('tsconfig.json', '{}')
    const langs = detectLanguages(tmpDir)
    expect(langs).toContain('typescript')
    expect(langs).toContain('javascript')
  })

  it('should detect TypeScript with tsconfig.base.json', () => {
    touch('package.json', '{}')
    touch('tsconfig.base.json', '{}')
    const langs = detectLanguages(tmpDir)
    expect(langs).toContain('typescript')
  })

  it('should detect JavaScript without tsconfig', () => {
    touch('package.json', '{}')
    const langs = detectLanguages(tmpDir)
    expect(langs).not.toContain('typescript')
    expect(langs).toContain('javascript')
  })

  it('should detect Rust', () => {
    touch('Cargo.toml', '')
    expect(detectLanguages(tmpDir)).toContain('rust')
  })

  it('should detect Go', () => {
    touch('go.mod', '')
    expect(detectLanguages(tmpDir)).toContain('go')
  })

  it('should detect Python', () => {
    touch('requirements.txt', '')
    expect(detectLanguages(tmpDir)).toContain('python')
  })

  it('should detect Python via pyproject.toml', () => {
    touch('pyproject.toml', '')
    expect(detectLanguages(tmpDir)).toContain('python')
  })

  it('should detect Ruby', () => {
    touch('Gemfile', '')
    expect(detectLanguages(tmpDir)).toContain('ruby')
  })

  it('should detect Java', () => {
    touch('pom.xml', '')
    expect(detectLanguages(tmpDir)).toContain('java')
  })

  it('should detect Swift', () => {
    touch('Package.swift', '')
    expect(detectLanguages(tmpDir)).toContain('swift')
  })

  it('should detect Dart', () => {
    touch('pubspec.yaml', '')
    expect(detectLanguages(tmpDir)).toContain('dart')
  })

  it('should return empty for unrecognized project', () => {
    expect(detectLanguages(tmpDir)).toEqual([])
  })
})

describe('detectPackageManagers', () => {
  it('should detect pnpm', () => {
    touch('pnpm-lock.yaml', '')
    expect(detectPackageManagers(tmpDir)).toContain('pnpm')
  })

  it('should detect yarn', () => {
    touch('yarn.lock', '')
    expect(detectPackageManagers(tmpDir)).toContain('yarn')
  })

  it('should detect npm', () => {
    touch('package-lock.json', '')
    expect(detectPackageManagers(tmpDir)).toContain('npm')
  })

  it('should detect cargo', () => {
    touch('Cargo.lock', '')
    expect(detectPackageManagers(tmpDir)).toContain('cargo')
  })

  it('should detect go', () => {
    touch('go.sum', '')
    expect(detectPackageManagers(tmpDir)).toContain('go')
  })
})

describe('detectFrameworks', () => {
  it('should detect Next.js', () => {
    touch('package.json', JSON.stringify({ dependencies: { next: '14.0.0', react: '18.0.0' } }))
    const fw = detectFrameworks(tmpDir)
    expect(fw).toContain('nextjs')
    expect(fw).toContain('react')
  })

  it('should detect Vue', () => {
    touch('package.json', JSON.stringify({ dependencies: { vue: '3.0.0' } }))
    expect(detectFrameworks(tmpDir)).toContain('vue')
  })

  it('should detect Svelte', () => {
    touch('package.json', JSON.stringify({ devDependencies: { svelte: '4.0.0' } }))
    expect(detectFrameworks(tmpDir)).toContain('svelte')
  })

  it('should detect Express', () => {
    touch('package.json', JSON.stringify({ dependencies: { express: '4.0.0' } }))
    expect(detectFrameworks(tmpDir)).toContain('express')
  })

  it('should detect Vite', () => {
    touch('package.json', JSON.stringify({ devDependencies: { vite: '5.0.0' } }))
    expect(detectFrameworks(tmpDir)).toContain('vite')
  })

  it('should detect Expo', () => {
    touch('package.json', JSON.stringify({ dependencies: { expo: '50.0.0' } }))
    expect(detectFrameworks(tmpDir)).toContain('expo')
  })

  it('should handle malformed package.json', () => {
    touch('package.json', 'not json')
    expect(detectFrameworks(tmpDir)).toEqual([])
  })

  it('should handle no package.json', () => {
    expect(detectFrameworks(tmpDir)).toEqual([])
  })
})

describe('detectCI', () => {
  it('should detect GitHub Actions', () => {
    mkdirSync(join(tmpDir, '.github', 'workflows'), { recursive: true })
    touch('.github/workflows/ci.yml', '')
    expect(detectCI(tmpDir)).toContain('github-actions')
  })

  it('should detect GitLab CI', () => {
    touch('.gitlab-ci.yml', '')
    expect(detectCI(tmpDir)).toContain('gitlab-ci')
  })

  it('should detect Docker', () => {
    touch('Dockerfile', '')
    expect(detectCI(tmpDir)).toContain('docker')
  })

  it('should detect Vercel', () => {
    touch('vercel.json', '')
    expect(detectCI(tmpDir)).toContain('vercel')
  })

  it('should detect Cloudflare', () => {
    touch('wrangler.toml', '')
    expect(detectCI(tmpDir)).toContain('cloudflare')
  })
})

describe('detectTests', () => {
  it('should detect Vitest', () => {
    touch('package.json', JSON.stringify({ devDependencies: { vitest: '1.0.0' } }))
    expect(detectTests(tmpDir)).toContain('vitest')
  })

  it('should detect Jest', () => {
    touch('package.json', JSON.stringify({ devDependencies: { jest: '29.0.0' } }))
    expect(detectTests(tmpDir)).toContain('jest')
  })

  it('should detect Playwright', () => {
    touch('package.json', JSON.stringify({ devDependencies: { '@playwright/test': '1.40.0' } }))
    expect(detectTests(tmpDir)).toContain('playwright')
  })

  it('should detect pytest', () => {
    touch('pytest.ini', '')
    expect(detectTests(tmpDir)).toContain('pytest')
  })
})

describe('detectCodeRoots', () => {
  it('should detect common top-level code roots', () => {
    mkdirSync(join(tmpDir, 'apps'), { recursive: true })
    mkdirSync(join(tmpDir, 'packages'), { recursive: true })
    mkdirSync(join(tmpDir, 'docs'), { recursive: true })

    expect(detectCodeRoots(tmpDir)).toEqual(['apps', 'packages'])
  })
})

describe('detectPackageScripts', () => {
  it('should return package.json script names', () => {
    touch('package.json', JSON.stringify({
      scripts: { dev: 'vite', build: 'vite build', test: 'vitest' },
    }))

    expect(detectPackageScripts(tmpDir)).toEqual(['dev', 'build', 'test'])
  })
})

describe('scanReadme', () => {
  it('should read README.md', () => {
    touch('README.md', '# My Project\n\nA great project.')
    expect(scanReadme(tmpDir)).toBe('# My Project\n\nA great project.')
  })

  it('should truncate at 500 chars', () => {
    touch('README.md', 'x'.repeat(600))
    expect(scanReadme(tmpDir)?.length).toBe(500)
  })

  it('should return undefined when no README', () => {
    expect(scanReadme(tmpDir)).toBeUndefined()
  })

  it('should try readme.md (lowercase)', () => {
    touch('readme.md', '# hello')
    expect(scanReadme(tmpDir)).toBe('# hello')
  })
})

describe('hasLocalProgress', () => {
  it('ignores assignee-only task churn', () => {
    const previous = makeLocalObservationState({
      health: { agents: [] },
      tasks: [
        { id: 'task-1', title: 'Implement feature', priority: 5, status: 'assigned', assignee: 'dev' },
      ],
    })

    const current = makeLocalObservationState({
      health: { agents: [] },
      tasks: [
        { id: 'task-1', title: 'Implement feature', priority: 5, status: 'assigned', assignee: 'dev-2' },
      ],
    })

    expect(hasLocalProgress(previous, current)).toBe(false)
  })

  it('ignores supervisor polling noise in logs', () => {
    const previous = makeLocalObservationState({
      logs: ['12:00:00 supervisor     rpc'],
    })

    const current = makeLocalObservationState({
      logs: ['12:00:00 supervisor     rpc', '12:00:15 supervisor     rpc'],
    })

    expect(hasLocalProgress(previous, current)).toBe(false)
  })

  it('ignores agent lifecycle log churn', () => {
    const previous = makeLocalObservationState({
      logs: ['12:00:00 supervisor     rpc'],
    })

    const current = makeLocalObservationState({
      logs: [
        '12:00:00 supervisor     rpc',
        '12:00:02 agent-process  item_completed (ceo)',
      ],
    })

    expect(hasLocalProgress(previous, current)).toBe(false)
  })

  it('ignores completed-runs churn without state changes', () => {
    const previous = makeLocalObservationState({
      health: { agents: [], runtime: { completedRuns: 1 } },
    })

    const current = makeLocalObservationState({
      health: { agents: [], runtime: { completedRuns: 4 } },
    })

    expect(hasLocalProgress(previous, current)).toBe(false)
  })

  it('treats task status changes as progress', () => {
    const previous = makeLocalObservationState({
      health: { agents: [] },
      tasks: [
        { id: 'task-1', title: 'Implement feature', priority: 5, status: 'assigned', assignee: 'dev' },
      ],
    })

    const current = makeLocalObservationState({
      health: { agents: [] },
      tasks: [
        { id: 'task-1', title: 'Implement feature', priority: 5, status: 'done', assignee: 'dev-2' },
      ],
    })

    expect(hasLocalProgress(previous, current)).toBe(true)
  })

  it('treats artifact growth as progress', () => {
    const previous = makeLocalObservationState({
      artifacts: [{ agent: 'finance', kind: 'report', cnt: 1 }],
    })

    const current = makeLocalObservationState({
      artifacts: [{ agent: 'finance', kind: 'report', cnt: 2 }],
    })

    expect(hasLocalProgress(previous, current)).toBe(true)
  })

  it('treats git worktree changes as progress', () => {
    const previous = makeLocalObservationState({
      activeBranch: 'wanman/initial',
      branchAhead: 0,
      modifiedFiles: [],
    })

    const current = makeLocalObservationState({
      activeBranch: 'wanman/initial',
      branchAhead: 1,
      modifiedFiles: ['README.md'],
    })

    expect(hasLocalProgress(previous, current)).toBe(true)
  })
})

describe('scanProject', () => {
  it('should produce a complete profile for a TypeScript project', () => {
    touch('package.json', JSON.stringify({
      dependencies: { next: '14.0.0', react: '18.0.0' },
      devDependencies: { vitest: '1.0.0', typescript: '5.0.0' },
    }))
    touch('tsconfig.json', '{}')
    touch('pnpm-lock.yaml', '')
    touch('README.md', '# My App')
    mkdirSync(join(tmpDir, '.github', 'workflows'), { recursive: true })
    touch('.github/workflows/ci.yml', '')

    const profile = scanProject(tmpDir)
    expect(profile.languages).toContain('typescript')
    expect(profile.frameworks).toContain('nextjs')
    expect(profile.testFrameworks).toContain('vitest')
    expect(profile.packageManagers).toContain('pnpm')
    expect(profile.ci).toContain('github-actions')
    expect(profile.hasReadme).toBe(true)
    expect(profile.readmeExcerpt).toBe('# My App')
    expect(profile.codeRoots).toEqual([])
  })

  it('should produce a minimal profile for an empty directory', () => {
    const profile = scanProject(tmpDir)
    expect(profile.languages).toEqual([])
    expect(profile.frameworks).toEqual([])
    expect(profile.ci).toEqual([])
    expect(profile.hasReadme).toBe(false)
    expect(profile.issueTracker).toBe('none')
  })
})

describe('generateAgentConfig', () => {
  const fullProfile = makeProfile({
    path: '/tmp/test',
    frameworks: ['nextjs', 'react'],
  })

  it('should enable all agents for a full-featured project', () => {
    const config = generateAgentConfig(fullProfile)
    expect(config.agents.filter(a => a.enabled)).toHaveLength(6)
  })

  it('should always enable ceo and dev', () => {
    const config = generateAgentConfig({ ...fullProfile, ci: [], issueTracker: 'none', hasReadme: false, hasDocs: false })
    const enabled = config.agents.filter(a => a.enabled).map(a => a.name)
    expect(enabled).toContain('ceo')
    expect(enabled).toContain('dev')
  })

  it('should disable devops when no CI detected', () => {
    const config = generateAgentConfig({ ...fullProfile, ci: [], packageScripts: [] })
    const devops = config.agents.find(a => a.name === 'devops')!
    expect(devops.enabled).toBe(false)
  })

  it('should disable feedback when no issue tracker', () => {
    const config = generateAgentConfig({ ...fullProfile, issueTracker: 'none', hasReadme: false, hasDocs: false })
    const feedback = config.agents.find(a => a.name === 'feedback')!
    expect(feedback.enabled).toBe(false)
  })

  it('should disable marketing when no docs', () => {
    const config = generateAgentConfig({ ...fullProfile, hasReadme: false, hasDocs: false })
    const marketing = config.agents.find(a => a.name === 'marketing')!
    expect(marketing.enabled).toBe(false)
  })

  it('should use goal override when provided', () => {
    const config = generateAgentConfig(fullProfile, 'Custom goal override')
    expect(config.goal).toBe('Custom goal override')
  })

  it('should auto-infer goal when no override', () => {
    const config = generateAgentConfig(fullProfile)
    expect(config.goal).toContain('nextjs')
    expect(config.goal).toContain('Continuously take over and advance')
  })

  it('should default to claude runtime', () => {
    const config = generateAgentConfig(fullProfile)
    expect(config.runtime).toBe('claude')
    for (const agent of config.agents) {
      expect(agent.runtime).toBe('claude')
    }
    expect(config.agents.find(a => a.name === 'ceo')!.model).toBe('high')
    expect(config.agents.find(a => a.name === 'devops')!.model).toBe('standard')
  })

  it('should keep abstract model tiers when runtime is codex', () => {
    const config = generateAgentConfig(fullProfile, undefined, 'codex')
    expect(config.runtime).toBe('codex')
    for (const agent of config.agents) {
      expect(agent.runtime).toBe('codex')
    }
    expect(config.agents.find(a => a.name === 'ceo')!.model).toBe('high')
    expect(config.agents.find(a => a.name === 'dev')!.model).toBe('high')
    expect(config.agents.find(a => a.name === 'devops')!.model).toBe('standard')
  })
})

describe('inferGoal', () => {
  it('should include framework in goal', () => {
    const goal = inferGoal(makeProfile({ languages: ['typescript'], frameworks: ['nextjs'] }))
    expect(goal).toContain('nextjs')
    expect(goal).toContain('typescript')
  })

  it('should handle no framework', () => {
    const goal = inferGoal(makeProfile({ languages: ['python'], frameworks: [] }))
    expect(goal).toContain('python')
  })

  it('should handle no language', () => {
    const goal = inferGoal(makeProfile({ languages: [], frameworks: [] }))
    expect(goal).toContain(basename(tmpDir))
  })
})

describe('project intent', () => {
  it('should prioritize roadmap and docs files when building intent', () => {
    touch('README.md', '# Test App\n\nA useful product.')
    touch('ROADMAP.md', '# Roadmap\n\n## Phase 1\n- ship auth\n')
    mkdirSync(join(tmpDir, 'docs'), { recursive: true })
    touch('docs/architecture.md', '# Architecture\n\n## Services\n')
    touch('package.json', JSON.stringify({
      name: 'test-app',
      scripts: { build: 'vite build', test: 'vitest' },
    }))
    mkdirSync(join(tmpDir, 'src'), { recursive: true })

    const profile = scanProject(tmpDir)
    const docs = collectProjectDocs(tmpDir)
    const intent = buildProjectIntent(profile)

    expect(docs[0]?.kind).toBe('readme')
    expect(intent.roadmapDocs.map(doc => doc.path)).toContain('ROADMAP.md')
    expect(intent.strategicThemes.some(theme => theme.includes('roadmap'))).toBe(true)
    expect(intent.packageScripts).toContain('build')
    expect(intent.codeRoots).toContain('src')
  })
})

describe('materializeTakeoverProject', () => {
  it('should create a project-aware overlay with context skill', () => {
    touch('README.md', '# Test App\n\nA useful product.')
    touch('ROADMAP.md', '# Roadmap\n\n## Phase 1\n- ship auth\n')
    touch('package.json', JSON.stringify({ name: 'test-app', scripts: { test: 'vitest' } }))

    const profile = scanProject(tmpDir)
    const generated = generateAgentConfig(profile)
    const overlayDir = materializeTakeoverProject(profile, generated)

    const config = JSON.parse(readFileSync(join(overlayDir, 'agents.json'), 'utf-8')) as { workspaceRoot: string; gitRoot: string }
    expect(config.workspaceRoot).toBe('/workspace/project/repo/.wanman/agents')
    expect(config.gitRoot).toBe('/workspace/project/repo')
    expect(readFileSync(join(overlayDir, 'skills', 'takeover-context', 'SKILL.md'), 'utf-8')).toContain('/workspace/project/repo')
    expect(readFileSync(join(overlayDir, 'agents', 'ceo', 'AGENT.md'), 'utf-8')).toContain('continuously operating this project')
  })

  it('should include runtime in generated agents.json for codex', () => {
    touch('README.md', '# Codex Test')
    touch('package.json', JSON.stringify({ name: 'codex-app' }))

    const profile = scanProject(tmpDir)
    const generated = generateAgentConfig(profile, undefined, 'codex')
    const overlayDir = materializeTakeoverProject(profile, generated)

    const config = JSON.parse(readFileSync(join(overlayDir, 'agents.json'), 'utf-8')) as { agents: Array<{ name: string; runtime: string; model: string }> }
    for (const agent of config.agents) {
      expect(agent.runtime).toBe('codex')
    }
    const ceo = config.agents.find(a => a.name === 'ceo')!
    expect(ceo.model).toBe('high')
  })

  it('should create local takeover assets with local paths', () => {
    touch('README.md', '# Local Test')
    touch('package.json', JSON.stringify({ name: 'local-test' }))
    execSync('git init -b main', { cwd: tmpDir, stdio: 'pipe' })
    execSync('git add -A && git commit -m "init"', {
      cwd: tmpDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
      shell: '/bin/bash',
    })

    const profile = scanProject(tmpDir)
    const generated = generateAgentConfig(profile, undefined, 'codex')
    const overlayDir = materializeLocalTakeoverProject(profile, generated, { enableBrain: false })

    const skill = readFileSync(join(overlayDir, 'skills', 'takeover-context', 'SKILL.md'), 'utf-8')
    const agentGuide = readFileSync(join(overlayDir, 'agents', 'ceo', 'AGENT.md'), 'utf-8')
    const config = JSON.parse(readFileSync(join(overlayDir, 'agents.json'), 'utf-8')) as { gitRoot: string }

    expect(skill).toContain(join(tmpDir, '.wanman', 'worktree').replace(/\\/g, '/'))
    expect(skill).toContain('initiative list')
    expect(skill).toContain('capsule create')
    expect(skill).toContain('wanman initiative list')
    expect(skill).not.toContain('packages/cli/dist/index.js')
    expect(agentGuide).toContain(join(tmpDir, '.wanman', 'skills', 'takeover-context', 'SKILL.md').replace(/\\/g, '/'))
    expect(agentGuide).toContain('Create at least 3 tasks in the first CEO cycle')
    expect(agentGuide).toContain('visible backlog creation is mandatory')
    expect(agentGuide).toContain('capsule create')
    expect(agentGuide).toContain('wanman initiative list')
    expect(agentGuide).not.toContain('packages/cli/dist/index.js')
    expect(config.gitRoot).toBe(join(tmpDir, '.wanman', 'worktree'))
  })
})

describe('planLocalDynamicClone', () => {
  it('should parse local git status across branch, staged, unstaged, and untracked changes', () => {
    const state = parseLocalGitStatus([
      '# branch.oid abcdef1234567890',
      '# branch.head wanman/runtime-fix',
      '# branch.upstream origin/wanman/runtime-fix',
      '# branch.ab +2 -0',
      '1 M. N... 100644 100644 100644 abcdef abcdef packages/runtime/src/supervisor.ts',
      '1 .M N... 100644 100644 100644 abcdef abcdef packages/cli/src/commands/takeover.ts',
      '? docs/research/new-note.md',
    ].join('\n'))

    expect(state).toEqual({
      activeBranch: 'wanman/runtime-fix',
      branchAhead: 2,
      branchBehind: 0,
      hasUpstream: true,
      modifiedFiles: [
        'packages/runtime/src/supervisor.ts',
        'packages/cli/src/commands/takeover.ts',
        'docs/research/new-note.md',
      ],
    })
  })

  it('should treat detached HEAD as no active branch', () => {
    const state = parseLocalGitStatus([
      '# branch.oid abcdef1234567890',
      '# branch.head (detached)',
      '1 M. N... 100644 100644 100644 abcdef abcdef README.md',
    ].join('\n'))

    expect(state.activeBranch).toBeUndefined()
    expect(state.modifiedFiles).toEqual(['README.md'])
  })

  it('should spawn a shadow dev when dev has multiple unfinished tasks', () => {
    const action = planLocalDynamicClone(makeLocalObservationState({
      health: {
        agents: [
          { name: 'ceo', state: 'running', lifecycle: '24/7' },
          { name: 'dev', state: 'running', lifecycle: 'on-demand' },
        ],
      },
      tasks: [
        { id: 'task-1', title: 'Primary runtime fix', priority: 9, status: 'assigned', assignee: 'dev' },
        { id: 'task-2', title: 'Secondary CLI fix', priority: 8, status: 'assigned', assignee: 'dev' },
      ],
      initiatives: [],
      capsules: [],
      artifacts: [],
      logs: [],
      branchAhead: 0,
      hasUpstream: false,
      modifiedFiles: [],
    }))

    expect(action).toEqual({
      clonesToSpawn: ['dev-2'],
      reassignments: [
        { taskId: 'task-2', taskTitle: 'Secondary CLI fix', assignee: 'dev-2' },
      ],
    })
  })

  it('should not spawn when a dev clone already exists', () => {
    const action = planLocalDynamicClone(makeLocalObservationState({
      health: {
        agents: [
          { name: 'dev', state: 'running', lifecycle: 'on-demand' },
          { name: 'dev-2', state: 'idle', lifecycle: 'on-demand' },
        ],
      },
      tasks: [
        { id: 'task-1', title: 'Primary runtime fix', priority: 9, status: 'assigned', assignee: 'dev' },
        { id: 'task-2', title: 'Secondary CLI fix', priority: 8, status: 'assigned', assignee: 'dev' },
      ],
      initiatives: [],
      capsules: [],
      artifacts: [],
      logs: [],
      branchAhead: 0,
      hasUpstream: false,
      modifiedFiles: [],
    }))

    expect(action).toEqual({
      clonesToSpawn: [],
      reassignments: [
        { taskId: 'task-2', taskTitle: 'Secondary CLI fix', assignee: 'dev-2' },
      ],
    })
  })

  it('should not spawn when dev has fewer than two unfinished tasks', () => {
    const action = planLocalDynamicClone(makeLocalObservationState({
      health: {
        agents: [{ name: 'dev', state: 'running', lifecycle: 'on-demand' }],
      },
      tasks: [
        { id: 'task-1', title: 'Primary runtime fix', priority: 9, status: 'assigned', assignee: 'dev' },
      ],
      initiatives: [],
      capsules: [],
      artifacts: [],
      logs: [],
      branchAhead: 0,
      hasUpstream: false,
      modifiedFiles: [],
    }))

    expect(action).toBeNull()
  })
})

describe('takeoverCommand', () => {
  it('runs a local dry-run takeover and writes tier-based local overlay config', async () => {
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' })
    execSync('git config user.email test@example.com', { cwd: tmpDir, stdio: 'ignore' })
    execSync('git config user.name Test', { cwd: tmpDir, stdio: 'ignore' })
    touch('README.md', '# Test App\n\nA small app.')
    touch('package.json', JSON.stringify({
      scripts: { test: 'vitest', build: 'tsc' },
      dependencies: { react: '^18.0.0' },
      devDependencies: { vitest: '^4.0.0', typescript: '^5.0.0' },
    }))
    touch('pnpm-lock.yaml', '')
    execSync('git add README.md package.json pnpm-lock.yaml', { cwd: tmpDir, stdio: 'ignore' })
    execSync('git commit -m init', { cwd: tmpDir, stdio: 'ignore' })
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((message = '') => {
      logs.push(String(message))
    })

    try {
      await takeoverCommand([
        tmpDir,
        '--runtime', 'codex',
        '--goal', 'Custom OSS mission',
        '--dry-run',
        '--loops', '2',
        '--no-brain',
        '--codex-model', 'gpt-test',
      ])
    } finally {
      logSpy.mockRestore()
    }

    const config = JSON.parse(readFileSync(join(tmpDir, '.wanman', 'agents.json'), 'utf-8')) as {
      goal: string
      gitRoot: string
      agents: Array<{ runtime: string; model: string }>
    }
    expect(config.goal).toBe('Custom OSS mission')
    expect(config.gitRoot).toBe(join(tmpDir, '.wanman', 'worktree'))
    expect(new Set(config.agents.map(agent => agent.runtime))).toEqual(new Set(['codex']))
    expect(config.agents.map(agent => agent.model)).toContain('high')
    expect(config.agents.map(agent => agent.model)).toContain('standard')
    expect(readFileSync(join(tmpDir, '.wanman', 'agents', 'ceo', 'AGENT.md'), 'utf-8')).toContain('wanman task list')
    expect(logs.join('\n')).toContain('Dry run complete')
  })
})
