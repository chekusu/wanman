import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import {
  type AgentDefinition,
  type AgentMatrixConfig,
  type AgentRuntime,
} from '@wanman/core'

// Minimal local templates for the OSS takeover flow. The upstream CLI used a
// richer PRODUCTION_AGENTS registry, but the open-source surface keeps only the
// generic agent definitions and relies on `renderAgentInstructions` for the
// per-role AGENT.md content. Each template here is a short one-liner that is
// prefixed to the generated takeover prompt; the detailed operating guide
// lives in the AGENT.md file written to the overlay directory.
const TAKEOVER_AGENT_TEMPLATES: AgentDefinition[] = [
  {
    name: 'ceo',
    lifecycle: '24/7',
    model: 'high',
    systemPrompt: 'You are the CEO agent. Decompose the mission into initiatives, tasks, and change capsules; keep the backlog flowing. Read AGENT.md for the per-project operating guide before acting.',
  },
  {
    name: 'cto',
    lifecycle: 'on-demand',
    model: 'high',
    systemPrompt: 'You are the CTO agent. Gate code quality: review PRs, enforce the coverage gate, merge when ready. Read AGENT.md for the per-project operating guide before acting.',
  },
  {
    name: 'dev',
    lifecycle: 'on-demand',
    model: 'high',
    systemPrompt: 'You are a Dev agent. Implement assigned tasks end-to-end with tests and PRs, staying inside the capsule allowed paths. Read AGENT.md for the per-project operating guide before acting.',
  },
  {
    name: 'devops',
    lifecycle: '24/7',
    model: 'standard',
    systemPrompt: 'You are the DevOps agent. Keep CI, build, and release pipelines healthy. Read AGENT.md for the per-project operating guide before acting.',
  },
  {
    name: 'feedback',
    lifecycle: '24/7',
    model: 'standard',
    systemPrompt: 'You are the Feedback agent. Convert external signals (issues, TODOs, roadmap docs) into actionable tasks. Read AGENT.md for the per-project operating guide before acting.',
  },
  {
    name: 'marketing',
    lifecycle: '24/7',
    model: 'standard',
    systemPrompt: 'You are the Marketing agent. Maintain README/docs/external narrative in sync with implementation changes. Read AGENT.md for the per-project operating guide before acting.',
  },
]

export interface ProjectProfile {
  path: string
  languages: string[]
  packageManagers: string[]
  frameworks: string[]
  ci: string[]
  testFrameworks: string[]
  hasReadme: boolean
  hasClaudeMd: boolean
  hasDocs: boolean
  issueTracker: 'github' | 'none'
  githubRemote?: string
  readmeExcerpt?: string
  codeRoots?: string[]
  packageScripts?: string[]
}

export interface ProjectDocument {
  path: string
  kind: 'readme' | 'roadmap' | 'docs' | 'manifest' | 'notes'
  title: string
  excerpt: string
  headings: string[]
  score: number
}

export interface ProjectIntent {
  projectName: string
  summary: string
  canonicalDocs: ProjectDocument[]
  roadmapDocs: ProjectDocument[]
  codeRoots: string[]
  packageScripts: string[]
  strategicThemes: string[]
  mission: string
}

export interface GeneratedAgentConfig {
  runtime: AgentRuntime
  agents: Array<{
    name: string
    lifecycle: '24/7' | 'on-demand'
    runtime: AgentRuntime
    model: string
    systemPromptHint: string
    enabled: boolean
    reason: string
  }>
  goal: string
  intent: ProjectIntent
}

export interface TakeoverRuntimePaths {
  projectRoot: string
  sharedSkillPath: string
  cliCommand: string
  localMode?: boolean
}

export interface WriteTakeoverOverlayOptions {
  baseDir: string
  agentsDir: string
  skillsDir: string
  configPath: string
  workspaceRoot: string
  gitRoot: string
  dbPath: string
  runtimePaths: TakeoverRuntimePaths
  enableBrain?: boolean
  port?: number
}

const BASE_AGENT_MAP = new Map(TAKEOVER_AGENT_TEMPLATES.map(agent => [agent.name, agent] satisfies [string, AgentDefinition]))

export const SANDBOX_PROJECT_ROOT = '/workspace/project/repo'
export const SANDBOX_WORKSPACE_ROOT = `${SANDBOX_PROJECT_ROOT}/.wanman/agents`

const SANDBOX_RUNTIME_PATHS: TakeoverRuntimePaths = {
  projectRoot: SANDBOX_PROJECT_ROOT,
  sharedSkillPath: '/opt/wanman/shared-skills/takeover-context/SKILL.md',
  cliCommand: 'wanman',
}

export function detectLanguages(projectPath: string): string[] {
  const langs: string[] = []
  const has = (f: string) => fs.existsSync(path.join(projectPath, f))

  if (has('package.json')) langs.push('typescript', 'javascript')
  if (has('Cargo.toml')) langs.push('rust')
  if (has('go.mod')) langs.push('go')
  if (has('requirements.txt') || has('pyproject.toml') || has('setup.py')) langs.push('python')
  if (has('Gemfile')) langs.push('ruby')
  if (has('pom.xml') || has('build.gradle')) langs.push('java')
  if (has('Package.swift')) langs.push('swift')
  if (has('pubspec.yaml')) langs.push('dart')

  const hasTsConfig = has('tsconfig.json') || has('tsconfig.base.json') || has('tsconfig.build.json')
  if (langs.includes('typescript') && !hasTsConfig) {
    langs.splice(langs.indexOf('typescript'), 1)
  }

  return langs
}

export function detectPackageManagers(projectPath: string): string[] {
  const managers: string[] = []
  const has = (f: string) => fs.existsSync(path.join(projectPath, f))

  if (has('pnpm-lock.yaml') || has('pnpm-workspace.yaml')) managers.push('pnpm')
  else if (has('yarn.lock')) managers.push('yarn')
  else if (has('package-lock.json')) managers.push('npm')
  if (has('Cargo.lock')) managers.push('cargo')
  if (has('go.sum')) managers.push('go')
  if (has('Pipfile.lock') || has('poetry.lock')) managers.push('pip')

  return managers
}

export function detectFrameworks(projectPath: string): string[] {
  const frameworks: string[] = []
  const pkg = readPackageJson(projectPath)
  const allDeps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }

  if (allDeps['next']) frameworks.push('nextjs')
  if (allDeps['react']) frameworks.push('react')
  if (allDeps['vue']) frameworks.push('vue')
  if (allDeps['svelte'] || allDeps['@sveltejs/kit']) frameworks.push('svelte')
  if (allDeps['express']) frameworks.push('express')
  if (allDeps['fastify']) frameworks.push('fastify')
  if (allDeps['hono']) frameworks.push('hono')
  if (allDeps['expo']) frameworks.push('expo')
  if (allDeps['vite']) frameworks.push('vite')

  return frameworks
}

export function detectCI(projectPath: string): string[] {
  const ci: string[] = []
  const has = (f: string) => fs.existsSync(path.join(projectPath, f))

  if (has('.github/workflows') && fs.statSync(path.join(projectPath, '.github/workflows')).isDirectory()) ci.push('github-actions')
  if (has('.gitlab-ci.yml')) ci.push('gitlab-ci')
  if (has('.circleci/config.yml')) ci.push('circleci')
  if (has('Jenkinsfile')) ci.push('jenkins')
  if (has('Dockerfile') || has('docker-compose.yml')) ci.push('docker')
  if (has('vercel.json') || has('.vercel')) ci.push('vercel')
  if (has('wrangler.toml')) ci.push('cloudflare')

  return ci
}

export function detectTests(projectPath: string): string[] {
  const tests: string[] = []
  const pkg = readPackageJson(projectPath)
  const allDeps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }

  if (allDeps['vitest']) tests.push('vitest')
  if (allDeps['jest']) tests.push('jest')
  if (allDeps['mocha']) tests.push('mocha')
  if (allDeps['playwright'] || allDeps['@playwright/test']) tests.push('playwright')
  if (allDeps['cypress']) tests.push('cypress')

  const has = (f: string) => fs.existsSync(path.join(projectPath, f))
  if (has('pytest.ini') || has('conftest.py')) tests.push('pytest')

  return tests
}

export function detectGitHubRemote(projectPath: string): string | undefined {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim()
    if (remote.includes('github.com')) return remote
  } catch {
    // ignore
  }
  return undefined
}

export function scanReadme(projectPath: string): string | undefined {
  for (const name of ['README.md', 'readme.md', 'README.rst', 'README']) {
    const readmePath = path.join(projectPath, name)
    if (fs.existsSync(readmePath)) {
      try {
        return fs.readFileSync(readmePath, 'utf-8').slice(0, 500)
      } catch {
        // ignore
      }
    }
  }
  return undefined
}

export function detectCodeRoots(projectPath: string): string[] {
  const roots = ['src', 'app', 'apps', 'packages', 'services', 'backend', 'frontend', 'web', 'api', 'lib', 'cmd']
  return roots.filter(name => {
    const p = path.join(projectPath, name)
    return fs.existsSync(p) && fs.statSync(p).isDirectory()
  })
}

export function detectPackageScripts(projectPath: string): string[] {
  const pkg = readPackageJson(projectPath)
  return Object.keys(pkg?.scripts ?? {})
}

function readPackageJson(projectPath: string): Record<string, any> | null {
  const pkgPath = path.join(projectPath, 'package.json')
  if (!fs.existsSync(pkgPath)) return null
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, any>
  } catch {
    return null
  }
}

function readTextSnippet(filePath: string, maxChars = 1600): string {
  try {
    return fs.readFileSync(filePath, 'utf-8').slice(0, maxChars)
  } catch {
    return ''
  }
}

function extractHeadings(content: string): string[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^(#{1,3}\s+|[-*]\s+\[[ xX]\]\s+)/.test(line))
    .map(line => line.replace(/^#{1,3}\s+/, '').trim())
    .slice(0, 8)
}

function titleFromContent(filePath: string, content: string): string {
  const firstHeading = content
    .split('\n')
    .map(line => line.trim())
    .find(line => /^#\s+/.test(line))
  if (firstHeading) return firstHeading.replace(/^#\s+/, '').trim()
  return path.basename(filePath)
}

function scoreDocument(relativePath: string): { score: number; kind: ProjectDocument['kind'] } {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase()
  if (/^readme(\.|$)/.test(normalized)) return { score: 100, kind: 'readme' }
  if (/(^|\/)(roadmap|todo|backlog|milestone|plan|vision|prd|strategy)/.test(normalized)) return { score: 95, kind: 'roadmap' }
  if (/^claude\.md$/.test(normalized)) return { score: 85, kind: 'notes' }
  if (/^package\.json$|^pyproject\.toml$|^cargo\.toml$|^go\.mod$/.test(normalized)) return { score: 70, kind: 'manifest' }
  if (/^docs\/.+\.(md|mdx|rst|txt)$/.test(normalized)) return { score: 60, kind: 'docs' }
  if (/\.(md|mdx|rst|txt)$/.test(normalized)) return { score: 40, kind: 'notes' }
  return { score: 0, kind: 'notes' }
}

function walkDocsDir(root: string, dir: string, acc: string[], depth = 0): void {
  if (depth > 3) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkDocsDir(root, fullPath, acc, depth + 1)
      continue
    }
    const rel = path.relative(root, fullPath)
    if (/\.(md|mdx|rst|txt|json|toml|ya?ml)$/i.test(rel)) {
      acc.push(fullPath)
    }
  }
}

export function collectProjectDocs(projectPath: string): ProjectDocument[] {
  const candidates = new Set<string>()
  const rootFiles = [
    'README.md',
    'readme.md',
    'README.rst',
    'README',
    'CLAUDE.md',
    'ROADMAP.md',
    'ROADMAP',
    'TODO.md',
    'TODO',
    'CHANGELOG.md',
    'PLAN.md',
    'VISION.md',
    'package.json',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
  ]

  for (const name of rootFiles) {
    const fullPath = path.join(projectPath, name)
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      candidates.add(fullPath)
    }
  }

  const docsDir = path.join(projectPath, 'docs')
  if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
    const docFiles: string[] = []
    walkDocsDir(projectPath, docsDir, docFiles)
    for (const file of docFiles) candidates.add(file)
  }

  const deduped = new Map<string, ProjectDocument>()
  for (const filePath of Array.from(candidates)) {
    const relative = path.relative(projectPath, filePath).replace(/\\/g, '/')
    const { score, kind } = scoreDocument(relative)
    const excerpt = readTextSnippet(filePath)
    const doc = {
      path: relative,
      kind,
      title: titleFromContent(filePath, excerpt),
      excerpt,
      headings: extractHeadings(excerpt),
      score,
    } satisfies ProjectDocument
    if (doc.score <= 0) continue

    const key = doc.path.toLowerCase()
    const existing = deduped.get(key)
    if (!existing || doc.score > existing.score || doc.path < existing.path) {
      deduped.set(key, doc)
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 10)
}

export function scanProject(projectPath: string): ProjectProfile {
  const absPath = path.resolve(projectPath)
  const has = (f: string) => fs.existsSync(path.join(absPath, f))
  const githubRemote = detectGitHubRemote(absPath)

  return {
    path: absPath,
    languages: detectLanguages(absPath),
    packageManagers: detectPackageManagers(absPath),
    frameworks: detectFrameworks(absPath),
    ci: detectCI(absPath),
    testFrameworks: detectTests(absPath),
    hasReadme: has('README.md') || has('readme.md'),
    hasClaudeMd: has('CLAUDE.md'),
    hasDocs: has('docs') && fs.statSync(path.join(absPath, 'docs')).isDirectory(),
    issueTracker: githubRemote ? 'github' : 'none',
    githubRemote,
    readmeExcerpt: scanReadme(absPath),
    codeRoots: detectCodeRoots(absPath),
    packageScripts: detectPackageScripts(absPath),
  }
}

function inferProjectName(profile: ProjectProfile, docs: ProjectDocument[]): string {
  const pkg = readPackageJson(profile.path)
  if (typeof pkg?.name === 'string' && pkg.name.trim()) return pkg.name.trim()
  const readme = docs.find(doc => doc.kind === 'readme')
  if (readme?.title) return readme.title
  return path.basename(profile.path)
}

function inferProjectSummary(profile: ProjectProfile, docs: ProjectDocument[]): string {
  const pkg = readPackageJson(profile.path)
  const description = typeof pkg?.description === 'string' ? pkg.description.trim() : ''
  if (description) return description

  const readme = docs.find(doc => doc.kind === 'readme')
  if (readme?.excerpt) {
    return readme.excerpt
      .replace(/\s+/g, ' ')
      .replace(/^#.+$/, '')
      .trim()
      .slice(0, 220) || `Maintain and advance ${inferProjectName(profile, docs)}`
  }

  const stack = [profile.frameworks[0], profile.languages[0]].filter(Boolean).join(' / ')
  return stack ? `${inferProjectName(profile, docs)} - ${stack} project` : `Maintain and advance ${inferProjectName(profile, docs)}`
}

function buildStrategicThemes(profile: ProjectProfile, docs: ProjectDocument[]): string[] {
  const themes = new Set<string>()
  const roadmapDocs = docs.filter(doc => doc.kind === 'roadmap')
  const ci = profile.ci ?? []
  const tests = profile.testFrameworks ?? []

  if (roadmapDocs.length > 0) {
    themes.add('Prioritize advancing incomplete roadmap / plan / backlog items closest to user value')
  }
  if (profile.hasReadme || profile.hasDocs) {
    themes.add('Keep README, docs, and changelog consistent with current implementation and release state')
  }
  if (ci.length > 0 || tests.length > 0) {
    themes.add('Continuously keep tests, CI, build, and release pipelines operational - not just surface fixes')
  }
  if ((profile.codeRoots?.length ?? 0) > 0) {
    themes.add(`Continuously review core code directories ${profile.codeRoots!.join(', ')} for structural issues blocking the roadmap`)
  }
  if (profile.issueTracker !== 'none') {
    themes.add('Continuously absorb signals from issues / feedback / discussions and convert external problems into actionable tasks')
  } else {
    themes.add('When external issue sources are unavailable, proactively mine backlog from code, docs, TODOs, and scripts')
  }
  themes.add('After any single metric reaches a local optimum, return to the global mission and find the next batch of high-value tasks')

  return Array.from(themes)
}

export function buildProjectIntent(profile: ProjectProfile): ProjectIntent {
  const docs = collectProjectDocs(profile.path)
  const projectName = inferProjectName(profile, docs)
  const summary = inferProjectSummary(profile, docs)
  const roadmapDocs = docs.filter(doc => doc.kind === 'roadmap')
  const codeRoots = profile.codeRoots ?? []
  const packageScripts = profile.packageScripts ?? []
  const strategicThemes = buildStrategicThemes(profile, docs)
  const stack = [profile.frameworks[0], profile.languages[0]].filter(Boolean).join(' / ')
  const mission = [
    `Continuously take over and advance ${projectName}${stack ? ` (${stack})` : ''}.`,
    `Project summary: ${summary}`,
    `Operating principles: ${strategicThemes.join('; ')}`,
  ].join(' ')

  return {
    projectName,
    summary,
    canonicalDocs: docs,
    roadmapDocs,
    codeRoots,
    packageScripts,
    strategicThemes,
    mission,
  }
}

export function inferGoal(profile: ProjectProfile, intent = buildProjectIntent(profile)): string {
  return intent.mission
}

export function generateAgentConfig(
  profile: ProjectProfile,
  goalOverride?: string,
  runtime: AgentRuntime = 'claude',
): GeneratedAgentConfig {
  const intent = buildProjectIntent(profile)
  const goal = goalOverride || inferGoal(profile, intent)

  const canOperateContinuously = profile.hasReadme || profile.hasDocs || intent.roadmapDocs.length > 0
  const hasExecutionSurface = profile.ci.length > 0 || (profile.packageScripts?.length ?? 0) > 0

  const agents: GeneratedAgentConfig['agents'] = [
    {
      name: 'ceo',
      lifecycle: '24/7',
      runtime,
      model: 'high',
      systemPromptHint: `Project: ${intent.projectName}; Summary: ${intent.summary.slice(0, 120)}`,
      enabled: true,
      reason: 'Always enabled - responsible for long-term mission orchestration and backlog generation',
    },
    {
      name: 'cto',
      lifecycle: 'on-demand',
      runtime,
      model: 'high',
      systemPromptHint: `Tests: ${profile.testFrameworks.join(', ') || 'none'}; CI: ${profile.ci.join(', ') || 'none'}`,
      enabled: true,
      reason: 'Always enabled - responsible for PR review with coverage gate and merge decisions',
    },
    {
      name: 'dev',
      lifecycle: 'on-demand',
      runtime,
      model: 'high',
      systemPromptHint: `Code roots: ${(profile.codeRoots ?? []).join(', ') || 'repo root'}; Tests: ${profile.testFrameworks.join(', ') || 'none'}`,
      enabled: true,
      reason: 'Always enabled - responsible for actual code implementation and verification',
    },
    {
      name: 'devops',
      lifecycle: '24/7',
      runtime,
      model: 'standard',
      systemPromptHint: `CI: ${profile.ci.join(', ') || 'none'}; scripts: ${(profile.packageScripts ?? []).join(', ') || 'none'}`,
      enabled: hasExecutionSurface,
      reason: hasExecutionSurface ? 'CI / build / test entry points detected - suitable for continuous pipeline guardianship' : 'No stable build/test/CI entry points detected',
    },
    {
      name: 'feedback',
      lifecycle: '24/7',
      runtime,
      model: 'standard',
      systemPromptHint: `Issue tracker: ${profile.issueTracker}; roadmap docs: ${intent.roadmapDocs.length}`,
      enabled: canOperateContinuously,
      reason: canOperateContinuously ? 'Continuously mining backlog from issues, roadmap, TODOs, and docs' : 'Insufficient roadmap/docs/issue signals - not deployed standalone',
    },
    {
      name: 'marketing',
      lifecycle: '24/7',
      runtime,
      model: 'standard',
      systemPromptHint: `Docs: ${profile.hasDocs ? 'yes' : 'no'}; README: ${profile.hasReadme ? 'yes' : 'no'}`,
      enabled: profile.hasReadme || profile.hasDocs,
      reason: (profile.hasReadme || profile.hasDocs) ? 'README/docs detected - continuous maintenance of external narrative required' : 'No README/docs detected',
    },
  ]

  return { runtime, agents, goal, intent }
}

function applyCliCommand(template: string, cliCommand: string): string {
  return template.replaceAll('wanman ', `${cliCommand} `)
}

function maybeGetDb9Token(): string | undefined {
  if (process.env['DB9_TOKEN']) return process.env['DB9_TOKEN']
  try {
    return execSync('db9 token show 2>/dev/null', { encoding: 'utf-8' }).trim() || undefined
  } catch {
    return undefined
  }
}

function buildTakeoverSystemPrompt(
  base: AgentDefinition,
  intent: ProjectIntent,
  paths: TakeoverRuntimePaths = SANDBOX_RUNTIME_PATHS,
): string {
  const basePrompt = applyCliCommand(
    base.systemPrompt.replace(/CLAUDE\.md/g, 'AGENT.md'),
    paths.cliCommand,
  )
  return `${basePrompt}\n\nCurrent takeover project: ${intent.projectName}.\nLong-running mission: ${intent.mission}\nRead ${paths.sharedSkillPath} and AGENT.md in your working directory before starting work.`
}

function toProjectPath(relativePath: string, projectRoot: string): string {
  return `${projectRoot}/${relativePath.replace(/\\/g, '/')}`
}

function renderTakeoverContextSkill(
  profile: ProjectProfile,
  intent: ProjectIntent,
  paths: TakeoverRuntimePaths = SANDBOX_RUNTIME_PATHS,
): string {
  const docs = intent.canonicalDocs.length > 0
    ? intent.canonicalDocs
      .map(doc => `- \`${toProjectPath(doc.path, paths.projectRoot)}\` - ${doc.title}`)
      .join('\n')
    : '- (none detected)'
  const roadmapHints = intent.roadmapDocs.flatMap(doc => doc.headings).slice(0, 8)
  const roadmapSection = roadmapHints.length > 0
    ? roadmapHints.map(item => `- ${item}`).join('\n')
    : '- No explicit roadmap file detected - reverse-engineer roadmap from code structure, TODOs, and documentation gaps'
  const codeRoots = intent.codeRoots.length > 0
    ? intent.codeRoots.map(root => `- \`${toProjectPath(root, paths.projectRoot)}\``).join('\n')
    : `- \`${paths.projectRoot}\``
  const scripts = intent.packageScripts.length > 0
    ? intent.packageScripts.map(name => `- \`${name}\``).join('\n')
    : '- (none detected)'
  const stack = [
    intent.projectName,
    profile.frameworks.join(', ') || 'no-framework-detected',
    profile.languages.join(', ') || 'no-language-detected',
  ].join(' | ')

  return applyCliCommand(`---
name: takeover-context
description: project-specific takeover mission, roadmap, code roots, and operating rules
---

# Takeover Context

## Project

- Repo root: \`${paths.projectRoot}\`
- Stack: ${stack}
- Summary: ${intent.summary}

## Long-Running Mission

${intent.mission}

## Canonical Files To Read First

${docs}

## Roadmap Signals

${roadmapSection}

## Code Roots

${codeRoots}

## Useful Scripts

${scripts}

## Operating Rules

1. Do not collapse the mission into a single static metric. Test coverage, lint, or fixing one bug does not mean the project is "done."
2. Keep 1-3 active initiatives on the mission board at all times. Use \`wanman initiative list\` / \`wanman initiative create\` / \`wanman initiative update\` to keep them fresh.
3. Every loop, re-ask: is the current backlog advancing real product goals, the roadmap, release readiness, or user value?
4. When all current tasks are complete, immediately refresh initiatives and generate the next batch from roadmap, README/docs, code structure, TODOs, build pipelines, and release gaps.
5. If external issues/PRs are not directly accessible, use local docs, scripts, and code gaps as backlog signal sources.
6. Prefer creating tasks with file scope: use \`wanman task create ... --path <path>\` or \`--pattern <prefix>\`.
7. Every PR-sized code change should be represented as a change capsule before branch work expands: use \`wanman capsule create --task <id> --initiative <id> --paths <...>\`.
8. Tasks may be reassigned freely. Code changes may not leave the capsule boundary; if you discover out-of-scope work, report it and create a follow-up task/capsule.
9. All agents should write analysis results to their own \`output/\`, but actual code/doc changes should happen at the repo root.

## Git Workflow

You have full \`git\` and \`gh\` (GitHub CLI) access in this environment.

- Dev: create a feature branch -> write code + tests -> push -> open PR -> notify CTO
- CEO: maintain initiative board and create capsules for code work before branches sprawl
- CTO: review PR (coverage >= 95% gate) -> approve + merge, or request changes
- CEO: task decomposition and monitoring only - does NOT merge PRs
- Branch naming: \`wanman/<task-slug>\`
- Always run tests with coverage before pushing
`, paths.cliCommand)
}

function renderAgentInstructions(
  agentName: string,
  intent: ProjectIntent,
  paths: TakeoverRuntimePaths = SANDBOX_RUNTIME_PATHS,
): string {
  const intro = `First run \`cat ${paths.sharedSkillPath}\` to understand the project mission and canonical files. The repo root is \`${paths.projectRoot}\`.`
  const isLocalDemo = Boolean(paths.localMode)

  switch (agentName) {
    case 'ceo':
      return applyCliCommand(`# CEO Takeover Agent

${intro}

## Your Responsibilities

- You are not doing a one-time static decomposition - you are continuously operating this project
- Convert roadmap, README/docs, code structure, test pipelines, and backlog signals into a rolling task pool
- After any local metric reaches a milestone, continue finding the next set of higher-value tasks

## Startup Sequence

1. Read the takeover context skill
2. Read the 2-4 highest-signal canonical files listed therein
3. Run \`wanman initiative list\` and ensure 1-3 active initiatives exist
4. Run \`wanman task list\`
5. If tasks are empty, immediately decompose the mission into the first batch of initiative-linked tasks
6. For every code-shipping task, create a change capsule with branch + allowed paths + acceptance
7. If all tasks are done, re-scan roadmap/docs/code roots, refresh initiatives, and create the next batch

## First-Batch Requirement

- Do not wait for perfect global understanding before acting
- After reading the skill plus 2 canonical files, create the first batch immediately if the backlog is empty
- Create at least 3 tasks in the first CEO cycle unless the repo is genuinely trivial
- Mix task types: at least 1 product/code task and at least 1 docs/ops/quality task
- Every task must have a concrete assignee and scoped \`--path\` or \`--pattern\`
- Every task should reference an initiative with \`--initiative <id>\`
- Create foundational tasks first; only create downstream tasks after you can reference their upstream task IDs with \`--after\`

${isLocalDemo ? `## Local Demo Requirement

- This run is a local demo of takeover mode, so visible backlog creation is mandatory
- In your first active cycle, create the first 3-5 tasks before doing deeper backlog refinement
- Prefer fast, defensible decomposition over prolonged repo exploration
- If multiple candidates exist, bias toward \`packages/cli\`, \`packages/runtime\`, docs plans, and README-alignment work
` : ''}

## Task Design Principles

- Maintain a mission board of 1-3 active initiatives; pause or complete stale initiatives instead of letting the board grow without bound
- Prefer scoping tasks with \`--path\` or \`--pattern\`
- For code tasks, create a capsule immediately: \`wanman capsule create --task <id> --initiative <id> --owner <agent> --branch <name> --base <sha> --paths <...> --acceptance <...>\`
- Do not let dev agents start broad branch work without a capsule
- When one task consumes another task's output, declare the dependency with \`--after\`
- Maintain both product-advancement tasks and quality/docs/release tasks simultaneously
- Do not let the system stop at "tests are green so we're done" local optima
- If the roadmap is unclear, reverse-engineer real goals from README, package scripts, core directories, and TODOs
- Treat \`[blocked]\` tasks as waiting on dependencies, not as automatic escalation targets

## PR Workflow

PR review and merge are handled by the **CTO agent**, not you. Your role:

- Assign tasks to dev agents - they create branches and PRs inside capsule boundaries
- CTO reviews PRs (after coverage gate) and merges them
- You focus on task decomposition, monitoring, and backlog generation
- If CTO reports a design concern in a PR, help mediate or reassign the task
`, paths.cliCommand)
    case 'cto':
      return applyCliCommand(`# CTO Takeover Agent

${intro}

## Your Responsibilities

You are the **technical gatekeeper**. No code reaches main without your review.

- Review PRs created by dev agents
- Enforce the **coverage gate**: only review PRs with >= 95% test coverage
- Verify code quality, architecture alignment, and correctness
- Merge approved PRs or request specific changes

## PR Review Workflow

\`\`\`bash
# 1. Check capsules waiting for review
wanman capsule list --status in_review

# 2. For each capsule / PR, check CI status and coverage
gh pr checks <number>
gh pr view <number>  # read the PR body for coverage report

# 3. Coverage gate: if coverage < 95%, request more tests
gh pr review <number> --request-changes --body "Coverage is below 95%. Please add tests for: ..."

# 4. If coverage >= 95%, review the actual code
gh pr diff <number>

# 5. Approve and merge, or request changes
gh pr review <number> --approve
gh pr merge <number> --squash

# OR request changes:
gh pr review <number> --request-changes --body "Issue: ..."
\`\`\`

## Review Criteria

1. **Coverage gate** (hard requirement): PR body or CI must show >= 95% coverage on changed files
2. **Correctness**: Does the code do what the task description says?
3. **Tests**: Are tests meaningful (not just coverage padding)?
4. **No regressions**: Do existing tests still pass?
5. **Minimal scope**: Changes should match the capsule allowed paths and acceptance - no unrelated modifications

## After Merge

\`\`\`bash
# Notify CEO that the PR was merged
wanman send ceo "Merged PR #<number>: <title>"

# Notify the dev agent
wanman send dev "PR #<number> merged. Task complete."
\`\`\`

## When to Reject

- Coverage below 95% - always reject, no exceptions
- Tests that only assert \`true\` or mock everything - reject as coverage padding
- Changes that break existing tests - reject
- Scope creep (touching files unrelated to the capsule) - request split into separate PR
`, paths.cliCommand)
    case 'dev':
      return applyCliCommand(`# Dev Takeover Agent

${intro}

## Your Responsibilities

- Make real changes to code, configuration, and docs in the repo - do not just write reports in output
- The output directory is only for change summaries, verification records, and notes for CEO/others
- For every task, run the closest available verification commands

## Work Protocol

1. \`wanman recv\`
2. \`wanman capsule mine\`
3. \`wanman task list --assignee dev\`
4. Before coding, confirm the current task is linked to a capsule and stay inside its allowed paths
5. Locate and modify relevant files in \`${paths.projectRoot}\`
6. Run minimum necessary verification: prefer the project's existing scripts / tests / build
7. Write changed files, verification commands, and results to \`output/change-summary.md\`
8. When a PR is ready, mark the capsule \`in_review\`, then \`wanman task done\` and notify CTO/CEO

## Branch Workflow

For each task, follow this git workflow:

\`\`\`bash
# 1. Start from latest main
git checkout main && git pull origin main

# 2. Inspect your capsule and use its branch / allowed paths
wanman capsule mine
git checkout -b wanman/<task-slug>  # or the exact capsule branch

# 3. Write code AND tests - target >= 95% coverage on changed files

# 4. Run tests with coverage
pnpm test --coverage  # or pytest --cov, go test -cover, etc.

# 5. Commit (small, focused commits)
git add -A && git commit -m "<type>: <description>"

# 6. Push and open PR - include coverage in PR body
git push -u origin wanman/<task-slug>
gh pr create --title "<task title>" --body "$(cat <<PRBODY
## Changes
- ...

## Test Coverage
<paste coverage summary here - must be >= 95% on changed files>
PRBODY
)"

# 7. Notify CTO for review (NOT CEO)
wanman capsule update <capsule-id> --status in_review
wanman send cto "PR ready for review: <pr-url>"
\`\`\`

## Coverage Requirement

**CTO will reject any PR with < 95% test coverage on changed files.** This is a hard gate.

- Write tests for every new function, branch, and edge case
- Do not pad coverage with meaningless assertions - CTO will catch this
- If you cannot reach 95% (e.g., code requires external services), explain why in the PR body

## Additional Rules

- If your task has no capsule yet, do not keep broadening the branch. Ask CEO to create or link the correct capsule first.
- If you discover important out-of-scope work, finish the in-scope change first, then report the follow-up to CEO.
- If tests are green but the task only optimizes a local metric, proactively suggest higher-value next steps to CEO
- Aim for real, deliverable changes - do not just submit abstract suggestions
- Always run tests before pushing; do not open PRs with broken tests
- After CTO requests changes, fix and re-push to the same branch - do not create a new PR
`, paths.cliCommand)
    case 'devops':
      return applyCliCommand(`# DevOps Takeover Agent

${intro}

## Your Responsibilities

- Guard build, test, release, and runtime stability
- Expose breakpoints in CI, scripts, environments, and deployment documentation
- When the project enters a stable phase, continue finding release readiness, automation, and observability gaps

## Work Protocol

- Prioritize checking CI config, package scripts, Dockerfile, and deployment docs
- Write verification results and recommendations to \`output/devops-notes.md\`
- If the current pipeline is stable, do not idle - find ops/automation gaps that block the roadmap
`, paths.cliCommand)
    case 'feedback':
      return applyCliCommand(`# Feedback Takeover Agent

${intro}

## Your Responsibilities

- Convert signals from issues, roadmap, README/docs, TODOs, changelog, and code anomalies into backlog items
- When no external feedback API is available, the local repository itself is your signal source
- Help CEO continuously discover "what is most worth doing next"

## Work Protocol

- Periodically scan the canonical docs and roadmap headings in the takeover context
- Record issues, gaps, documentation drift, uncovered boundaries, and potential user pain points in \`output/feedback-report.md\`
- Proactively send high-value findings to CEO - do not wait to be asked
${isLocalDemo ? '- In local demo mode, send at least one concrete backlog suggestion to CEO during your first active cycle\n' : ''}
`, paths.cliCommand)
    case 'marketing':
      return applyCliCommand(`# Marketing Takeover Agent

${intro}

## Your Responsibilities

- Continuously maintain the project's external narrative: README, docs, changelog, release notes, descriptive text
- When code and documentation diverge, proactively push corrections
- When product direction changes, update external messaging - do not let docs stagnate in an old state

## Work Protocol

- Start by reading README and docs, then review recent code/config changes
- Write documentation update plans and results to \`output/marketing-notes.md\`
- If no obvious documentation tasks exist, proactively find places where "implementation changed but docs didn't"
${isLocalDemo ? '- In local demo mode, send at least one concrete docs or messaging gap to CEO during your first active cycle\n' : ''}
`, paths.cliCommand)
    default:
      return `# ${agentName}\n\n${intro}\n`
  }
}

export function writeTakeoverOverlayFiles(
  profile: ProjectProfile,
  generated: GeneratedAgentConfig,
  options: WriteTakeoverOverlayOptions,
): void {
  fs.mkdirSync(options.agentsDir, { recursive: true })
  fs.mkdirSync(options.skillsDir, { recursive: true })

  const enabledAgents = generated.agents
    .filter(agent => agent.enabled)
    .map(agent => {
      const base = BASE_AGENT_MAP.get(agent.name)
      if (!base) throw new Error(`Unknown agent template: ${agent.name}`)
      return {
        ...base,
        lifecycle: agent.lifecycle,
        runtime: agent.runtime,
        model: agent.model,
        systemPrompt: buildTakeoverSystemPrompt(base, generated.intent, options.runtimePaths),
      } satisfies AgentDefinition
    })

  const config: AgentMatrixConfig = {
    agents: enabledAgents,
    dbPath: options.dbPath,
    port: options.port ?? 3120,
    workspaceRoot: options.workspaceRoot,
    gitRoot: options.gitRoot,
    goal: generated.goal,
    ...((options.enableBrain ?? true) && maybeGetDb9Token()
      ? { brain: { token: '${DB9_TOKEN}', dbName: '${WANMAN_BRAIN_NAME}' } }
      : {}),
  }

  fs.writeFileSync(options.configPath, JSON.stringify(config, null, 2))
  fs.writeFileSync(
    path.join(options.skillsDir, 'SKILL.md'),
    renderTakeoverContextSkill(profile, generated.intent, options.runtimePaths),
  )

  for (const agent of enabledAgents) {
    const agentDir = path.join(options.agentsDir, agent.name)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, 'AGENT.md'),
      renderAgentInstructions(agent.name, generated.intent, options.runtimePaths),
    )
  }
}

export function materializeTakeoverProject(
  profile: ProjectProfile,
  generated: GeneratedAgentConfig,
  opts?: { enableBrain?: boolean },
): string {
  const overlayDir = fs.mkdtempSync(path.join(tmpdir(), 'wanman-takeover-project-'))
  writeTakeoverOverlayFiles(profile, generated, {
    baseDir: overlayDir,
    agentsDir: path.join(overlayDir, 'agents'),
    skillsDir: path.join(overlayDir, 'skills', 'takeover-context'),
    configPath: path.join(overlayDir, 'agents.json'),
    workspaceRoot: SANDBOX_WORKSPACE_ROOT,
    gitRoot: SANDBOX_PROJECT_ROOT,
    dbPath: '/workspace/wanman.db',
    runtimePaths: SANDBOX_RUNTIME_PATHS,
    enableBrain: opts?.enableBrain,
  })
  return overlayDir
}
