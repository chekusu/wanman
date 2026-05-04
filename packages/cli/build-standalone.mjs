#!/usr/bin/env node
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const cliRoot = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(cliRoot, '../..')

function runPnpm(args, cwd) {
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/d', '/s', '/c', `pnpm ${args.join(' ')}`], { cwd, stdio: 'inherit' })
    return
  }
  execFileSync('pnpm', args, { cwd, stdio: 'inherit' })
}

console.log('[standalone] Building runtime & CLI...')
runPnpm(['--filter', '@wanman/runtime', 'build'], projectRoot)
runPnpm(['--filter', '@wanman/host-sdk', 'build'], projectRoot)
runPnpm(['--filter', '@wanman/cli', 'build'], projectRoot)

const { buildStandalone } = await import(new URL('./dist/standalone-build.js', import.meta.url))
await buildStandalone({
  cliRoot,
  projectRoot,
  args: process.argv.slice(2),
})

console.log('[standalone] Done!')
