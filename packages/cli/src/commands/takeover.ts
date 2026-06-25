/**
 * `wanman takeover` - Take over an existing git repo with autonomous agents.
 *
 * This command intentionally stays thin:
 * - parse takeover-specific CLI args
 * - scan the project and build the initial agent config
 * - dispatch into the local supervisor path (the only path supported in OSS)
 * - delegate project analysis details to dedicated modules
 */

import * as fs from 'node:fs'
import type { AgentRuntime } from '@wanman/core'
import type { RunOptions } from '@wanman/host-sdk'
import {
  type GeneratedAgentConfig,
  type ProjectDocument,
  type ProjectIntent,
  type ProjectProfile,
  buildProjectIntent,
  collectProjectDocs,
  detectCI,
  detectCodeRoots,
  detectFrameworks,
  detectGitHubRemote,
  detectLanguages,
  detectPackageManagers,
  detectPackageScripts,
  detectTests,
  generateAgentConfig,
  inferGoal,
  materializeTakeoverProject,
  scanProject,
  scanReadme,
} from '../takeover-project.js'
import {
  hasLocalProgress,
  materializeLocalTakeoverProject,
  parseLocalGitStatus,
  planLocalDynamicClone,
  runLocal,
} from '../takeover-local.js'
import { parseOptions } from './run.js'

export type {
  GeneratedAgentConfig,
  ProjectDocument,
  ProjectIntent,
  ProjectProfile,
}

export {
  buildProjectIntent,
  collectProjectDocs,
  detectCI,
  detectCodeRoots,
  detectFrameworks,
  detectGitHubRemote,
  detectLanguages,
  detectPackageManagers,
  detectPackageScripts,
  detectTests,
  generateAgentConfig,
  hasLocalProgress,
  inferGoal,
  materializeLocalTakeoverProject,
  materializeTakeoverProject,
  parseLocalGitStatus,
  planLocalDynamicClone,
  scanProject,
  scanReadme,
}

const TAKEOVER_HELP = `wanman takeover - Take over an existing git repo

Usage:
  wanman takeover <path> [options]

Runs the supervisor + agents locally against the target repo. Authenticate
agent runtimes on the host (e.g. 'claude login' or 'codex login') before
running.

Options:
  --goal <text>         Override auto-inferred long-running mission
  --runtime <name>      Agent runtime: claude (default) or codex
  --codex-model <name>  Codex model override
  --codex-effort <lvl>  Codex reasoning effort: low|medium|high|xhigh
  --codex-speed <lvl>   Alias for --codex-effort using fast|balanced|deep|max
  --dry-run             Scan and generate takeover overlay without launching
  --infinite            Run in infinite mode (default: true)
  --loops <n>           Run finite loops instead of infinite mode
  --poll <seconds>      Poll interval
  --keep                Keep supervisor alive on exit
  --output <path>       Deliverables directory
  --no-brain            Disable db9 brain
`

function splitTakeoverArgs(args: string[]): {
  projectPath: string
  goalOverride?: string
  runtime: AgentRuntime
  dryRun: boolean
  runArgs: string[]
} {
  const projectPath = args[0]!
  const runArgs: string[] = []
  let goalOverride: string | undefined
  let runtime: AgentRuntime = 'claude'
  let dryRun = false

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--goal':
        goalOverride = args[++i]
        break
      case '--runtime':
        runtime = args[++i] === 'codex' ? 'codex' : 'claude'
        break
      case '--dry-run':
        dryRun = true
        break
      default:
        runArgs.push(arg!)
        if (arg && arg.startsWith('--') && !['--infinite', '--keep', '--no-brain'].includes(arg)) {
          const next = args[i + 1]
          if (next && !next.startsWith('--')) {
            runArgs.push(next)
            i++
          }
        }
        break
    }
  }

  return { projectPath, goalOverride, runtime, dryRun, runArgs }
}

function hasExplicitRunMode(runArgs: string[]): boolean {
  return runArgs.includes('--infinite') || runArgs.includes('--loops')
}

/** @internal exported for testing */
export function buildTakeoverRunOptions(previewGoal: string, runArgs: string[]): RunOptions {
  const normalizedRunArgs = hasExplicitRunMode(runArgs) ? runArgs : ['--infinite', ...runArgs]
  return parseOptions([previewGoal, ...normalizedRunArgs]).opts
}

function printProjectSummary(profile: ProjectProfile, generated: GeneratedAgentConfig): void {
  console.log('\n  Project Profile:')
  console.log(`    Languages:   ${profile.languages.join(', ') || 'none'}`)
  console.log(`    Frameworks:  ${profile.frameworks.join(', ') || 'none'}`)
  console.log(`    CI/CD:       ${profile.ci.join(', ') || 'none'}`)
  console.log(`    Tests:       ${profile.testFrameworks.join(', ') || 'none'}`)
  console.log(`    Issues:      ${profile.issueTracker}`)
  console.log(`    README:      ${profile.hasReadme ? 'yes' : 'no'}`)
  console.log(`    Docs:        ${profile.hasDocs ? 'yes' : 'no'}`)
  console.log(`    Code Roots:  ${(profile.codeRoots ?? []).join(', ') || 'repo root'}`)

  console.log('\n  Project Intent:')
  console.log(`    Name:        ${generated.intent.projectName}`)
  console.log(`    Summary:     ${generated.intent.summary.slice(0, 120)}`)
  console.log(`    Docs:        ${generated.intent.canonicalDocs.map(doc => doc.path).join(', ') || 'none'}`)
  console.log('    Themes:')
  for (const theme of generated.intent.strategicThemes) {
    console.log(`      - ${theme}`)
  }
}

export async function takeoverCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(TAKEOVER_HELP)
    return
  }

  const { projectPath, goalOverride, runtime, dryRun, runArgs } = splitTakeoverArgs(args)
  if (!fs.existsSync(projectPath)) {
    console.error(`Error: path does not exist: ${projectPath}`)
    process.exit(1)
  }

  console.log(`\n  Scanning ${projectPath}...`)
  const profile = scanProject(projectPath)
  const generated = generateAgentConfig(profile, goalOverride, runtime)
  const previewGoal = generated.goal
  const opts = buildTakeoverRunOptions(previewGoal, runArgs)
  printProjectSummary(profile, generated)

  const overlayDir = materializeLocalTakeoverProject(profile, generated, { enableBrain: !opts.noBrain })

  console.log(`\n  Runtime: ${runtime}`)
  console.log(`  Goal: ${generated.goal}`)
  console.log('\n  Agents:')
  for (const agent of generated.agents) {
    const status = agent.enabled ? 'enabled' : 'disabled'
    console.log(`    [${status}] ${agent.name} (${agent.lifecycle}) - ${agent.reason}`)
  }
  console.log(`\n  Overlay: ${overlayDir}`)

  if (dryRun) {
    console.log(`\n  Dry run complete. Generated takeover overlay at ${overlayDir}`)
    return
  }

  await runLocal(profile, generated, overlayDir, opts)
}
