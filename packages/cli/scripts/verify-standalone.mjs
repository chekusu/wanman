#!/usr/bin/env node

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const cliRoot = path.resolve(scriptsDir, '..')
const projectRoot = path.resolve(cliRoot, '../..')
const bundlePath = path.join(cliRoot, 'dist', 'wanman.mjs')
const embeddedAssetsPath = path.join(cliRoot, 'src', 'embedded-assets.ts')

function runPnpm(args, cwd) {
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/d', '/s', '/c', `pnpm ${args.join(' ')}`], { cwd, stdio: 'inherit' })
    return
  }
  execFileSync('pnpm', args, { cwd, stdio: 'inherit' })
}

console.log('[standalone-test] Running pnpm --filter @wanman/cli standalone')
runPnpm(['--filter', '@wanman/cli', 'standalone'], projectRoot)

const bundleStat = fs.statSync(bundlePath)
if (bundleStat.size <= 0) {
  throw new Error(`[standalone-test] Empty standalone bundle: ${bundlePath}`)
}

if (fs.existsSync(embeddedAssetsPath)) {
  throw new Error(`[standalone-test] Temporary embedded asset file leaked: ${embeddedAssetsPath}`)
}

const helpText = execFileSync(process.execPath, [bundlePath, '--help'], {
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
if (!helpText.includes('wanman')) {
  throw new Error('[standalone-test] Standalone bundle help output did not mention "wanman"')
}

console.log(`[standalone-test] Verified packages/cli/dist/wanman.mjs (${(bundleStat.size / 1024).toFixed(0)} KB)`)
