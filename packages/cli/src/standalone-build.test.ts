import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  STANDALONE_BUNDLE_FILENAME,
  STANDALONE_BUNDLE_RELATIVE_PATH,
  assertStandaloneBundle,
  buildStandalone,
  collectDirectoryTextAssets,
  collectStandaloneAssets,
  getStandaloneCompileTargets,
  renderEmbeddedAssetsModule,
  resolveStandalonePaths,
  smokeTestStandaloneBundle,
  validateEmbeddedAssets,
} from './standalone-build.js'

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

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function createStandaloneFixture(): { projectRoot: string; cliRoot: string } {
  const projectRoot = makeTmpDir('wanman-standalone-')
  const cliRoot = path.join(projectRoot, 'packages', 'cli')
  writeFile(path.join(projectRoot, 'packages', 'runtime', 'dist', 'entrypoint.js'), 'console.log("runtime")\n')
  writeFile(path.join(cliRoot, 'dist', 'index.js'), 'console.log("cli")\n')
  writeFile(path.join(cliRoot, 'src', 'index.ts'), 'console.log("bundle")\n')
  writeFile(path.join(projectRoot, 'packages', 'core', 'skills', 'takeover-context', 'SKILL.md'), '# skill\n')
  return { projectRoot, cliRoot }
}

describe('standalone build helpers', () => {
  it('pins the documented bundle path', () => {
    expect(STANDALONE_BUNDLE_FILENAME).toBe('wanman.mjs')
    expect(STANDALONE_BUNDLE_RELATIVE_PATH).toBe(path.join('dist', 'wanman.mjs'))
  })

  it('collects standalone assets and validates optional agent assets', () => {
    const { projectRoot, cliRoot } = createStandaloneFixture()
    writeFile(path.join(projectRoot, 'packages', 'core', 'agents', 'dev', 'AGENT.md'), '# dev\n')
    writeFile(path.join(projectRoot, 'apps', 'container', 'agents.json'), '{"agents":[]}\n')
    writeFile(path.join(projectRoot, 'apps', 'container', 'products.json'), '{"products":[]}\n')

    const assets = collectStandaloneAssets(resolveStandalonePaths(cliRoot, projectRoot))

    expect(assets.ENTRYPOINT_JS).toContain('runtime')
    expect(assets.CLI_JS).toContain('cli')
    expect(assets.AGENT_SKILLS['dev']).toBe('# dev\n')
    expect(assets.SHARED_SKILLS['takeover-context']).toBe('# skill\n')
    expect(assets.AGENT_CONFIGS['agents.json']).toContain('"agents"')
    expect(assets.PRODUCTS_JSON).toContain('"products"')
  })

  it('fails fast when a required build artifact is missing', () => {
    const { projectRoot, cliRoot } = createStandaloneFixture()
    fs.rmSync(path.join(projectRoot, 'packages', 'runtime', 'dist', 'entrypoint.js'))

    expect(() => collectStandaloneAssets(resolveStandalonePaths(cliRoot, projectRoot))).toThrow(
      /Missing required runtime entrypoint\.js/,
    )
  })

  it('fails fast when the shared skills directory is missing entirely', () => {
    const { projectRoot, cliRoot } = createStandaloneFixture()
    fs.rmSync(path.join(projectRoot, 'packages', 'core', 'skills'), { recursive: true, force: true })

    expect(() => collectStandaloneAssets(resolveStandalonePaths(cliRoot, projectRoot))).toThrow(
      /Missing required shared skill directory/,
    )
  })

  it('fails fast when a shared skill directory is missing SKILL.md', () => {
    const { projectRoot } = createStandaloneFixture()
    const skillsRoot = path.join(projectRoot, 'packages', 'core', 'skills')
    fs.rmSync(skillsRoot, { recursive: true, force: true })
    fs.mkdirSync(path.join(skillsRoot, 'broken-skill'), { recursive: true })

    expect(() => collectDirectoryTextAssets(skillsRoot, 'SKILL.md', 'shared skill', { requireAtLeastOne: true })).toThrow(
      /Missing SKILL\.md/,
    )
  })

  it('fails fast when a required asset exists but is empty', () => {
    const { projectRoot, cliRoot } = createStandaloneFixture()
    writeFile(path.join(projectRoot, 'packages', 'runtime', 'dist', 'entrypoint.js'), ' \n')

    expect(() => collectStandaloneAssets(resolveStandalonePaths(cliRoot, projectRoot))).toThrow(
      /Empty required runtime entrypoint\.js/,
    )
  })

  it('fails when optional JSON manifests are invalid', () => {
    const { projectRoot, cliRoot } = createStandaloneFixture()
    writeFile(path.join(projectRoot, 'apps', 'container', 'agents-dev.json'), '{"agents":')

    expect(() => collectStandaloneAssets(resolveStandalonePaths(cliRoot, projectRoot))).toThrow(
      /Invalid agent config JSON/,
    )
  })

  it('fails when products.json is invalid', () => {
    const { projectRoot, cliRoot } = createStandaloneFixture()
    writeFile(path.join(projectRoot, 'apps', 'container', 'products.json'), '{"products":')

    expect(() => collectStandaloneAssets(resolveStandalonePaths(cliRoot, projectRoot))).toThrow(
      /Invalid products manifest JSON/,
    )
  })

  it('validates embedded assets before rendering the generated module', () => {
    expect(() =>
      validateEmbeddedAssets({
        ENTRYPOINT_JS: 'runtime',
        CLI_JS: 'cli',
        AGENT_CONFIGS: {},
        AGENT_SKILLS: {},
        SHARED_SKILLS: {},
        PRODUCTS_JSON: null,
      }),
    ).toThrow(/SHARED_SKILLS is empty/)

    const code = renderEmbeddedAssetsModule({
      ENTRYPOINT_JS: 'runtime',
      CLI_JS: 'cli',
      AGENT_CONFIGS: {},
      AGENT_SKILLS: { dev: '# dev\n' },
      SHARED_SKILLS: { takeover: '# skill\n' },
      PRODUCTS_JSON: null,
    })

    expect(code).toContain('export const ENTRYPOINT_JS = "runtime"')
    expect(code).toContain('"takeover": "# skill\\n"')
  })

  it('rejects empty embedded asset entries', () => {
    expect(() =>
      validateEmbeddedAssets({
        ENTRYPOINT_JS: 'runtime',
        CLI_JS: 'cli',
        AGENT_CONFIGS: { broken: ' ' },
        AGENT_SKILLS: { dev: '# dev\n' },
        SHARED_SKILLS: { takeover: '# skill\n' },
        PRODUCTS_JSON: '',
      }),
    ).toThrow(/AGENT_CONFIGS\.broken is empty; PRODUCTS_JSON is empty/)
  })

  it('parses compile flags deterministically', () => {
    expect(getStandaloneCompileTargets([])).toEqual({
      wantCompile: false,
      buildDarwin: false,
      buildLinux: false,
    })
    expect(getStandaloneCompileTargets(['--compile'])).toEqual({
      wantCompile: true,
      buildDarwin: true,
      buildLinux: false,
    })
    expect(getStandaloneCompileTargets(['--linux'])).toEqual({
      wantCompile: true,
      buildDarwin: false,
      buildLinux: true,
    })
    expect(getStandaloneCompileTargets(['--all'])).toEqual({
      wantCompile: true,
      buildDarwin: true,
      buildLinux: true,
    })
  })

  it('asserts the standalone bundle uses the promised filename', () => {
    const root = makeTmpDir('wanman-bundle-')
    const goodBundle = path.join(root, 'dist', 'wanman.mjs')
    const badBundle = path.join(root, 'dist', 'index.js')
    writeFile(goodBundle, '#!/usr/bin/env node\n')
    writeFile(badBundle, '#!/usr/bin/env node\n')

    expect(assertStandaloneBundle(goodBundle).size).toBeGreaterThan(0)
    expect(() => assertStandaloneBundle(badBundle)).toThrow(/Unexpected standalone bundle name/)
  })

  it('fails when the promised standalone bundle file is missing', () => {
    const root = makeTmpDir('wanman-bundle-missing-')
    const missingBundle = path.join(root, 'dist', 'wanman.mjs')

    expect(() => assertStandaloneBundle(missingBundle)).toThrow(/Missing standalone bundle/)
  })

  it('fails when the promised standalone bundle file is empty', () => {
    const root = makeTmpDir('wanman-bundle-empty-')
    const emptyBundle = path.join(root, 'dist', 'wanman.mjs')
    writeFile(emptyBundle, '')

    expect(() => assertStandaloneBundle(emptyBundle)).toThrow(/Empty standalone bundle/)
  })

  it('can smoke test an executable standalone bundle', () => {
    const root = makeTmpDir('wanman-bundle-smoke-')
    const bundlePath = path.join(root, 'dist', 'wanman.mjs')
    writeFile(bundlePath, 'console.log("wanman help")\n')

    expect(() => smokeTestStandaloneBundle(bundlePath)).not.toThrow()
  })

  it('reports smoke test failures with bundle context', () => {
    const root = makeTmpDir('wanman-bundle-smoke-fail-')
    const bundlePath = path.join(root, 'dist', 'wanman.mjs')
    writeFile(bundlePath, 'process.exit(1)\n')

    expect(() => smokeTestStandaloneBundle(bundlePath)).toThrow(/Standalone smoke test failed/)
  })

  it('builds the standalone bundle, runs smoke verification, and cleans up generated assets', async () => {
    const { projectRoot, cliRoot } = createStandaloneFixture()
    const smokeTest = vi.fn()
    const buildBundle = vi.fn(async ({ outfile }: { outfile?: string }) => {
      writeFile(outfile!, '#!/usr/bin/env node\nconsole.log("wanman help")\n')
      return {} as never
    })
    const execFile = vi.fn(() => '') as unknown as typeof import('node:child_process').execFileSync

    const result = await buildStandalone({
      cliRoot,
      projectRoot,
      buildBundle,
      execFile,
      smokeTest,
      log: () => {},
    })

    expect(buildBundle).toHaveBeenCalledTimes(1)
    expect(smokeTest).toHaveBeenCalledWith(path.join(cliRoot, 'dist', 'wanman.mjs'))
    expect(execFile).not.toHaveBeenCalled()
    expect(result.bundlePath).toBe(path.join(cliRoot, 'dist', 'wanman.mjs'))
    expect(fs.existsSync(path.join(cliRoot, 'src', 'embedded-assets.ts'))).toBe(false)
  })

  it('cleans up generated assets when the bundle build fails', async () => {
    const { projectRoot, cliRoot } = createStandaloneFixture()

    await expect(buildStandalone({
      cliRoot,
      projectRoot,
      buildBundle: vi.fn(async () => {
        throw new Error('bundle failed')
      }),
      log: () => {},
    })).rejects.toThrow(/bundle failed/)

    expect(fs.existsSync(path.join(cliRoot, 'src', 'embedded-assets.ts'))).toBe(false)
  })

  it('runs bun compile targets when requested', async () => {
    const { projectRoot, cliRoot } = createStandaloneFixture()
    const smokeTest = vi.fn()
    const buildBundle = vi.fn(async ({ outfile }: { outfile?: string }) => {
      writeFile(outfile!, '#!/usr/bin/env node\nconsole.log("wanman help")\n')
      return {} as never
    })
    const execFile = vi.fn((file: string, args?: readonly string[]) => {
      const outfileIndex = args?.indexOf('--outfile') ?? -1
      const relativeOutfile = outfileIndex >= 0 ? args?.[outfileIndex + 1] : undefined
      if (relativeOutfile) {
        writeFile(path.join(cliRoot, relativeOutfile), 'compiled')
      }
      return ''
    }) as unknown as typeof import('node:child_process').execFileSync

    await buildStandalone({
      cliRoot,
      projectRoot,
      args: ['--all'],
      buildBundle,
      execFile,
      smokeTest,
      log: () => {},
    })

    expect(execFile).toHaveBeenCalledTimes(2)
    expect(fs.existsSync(path.join(cliRoot, 'dist', 'wanman'))).toBe(true)
    expect(fs.existsSync(path.join(cliRoot, 'dist', 'wanman-linux'))).toBe(true)
  })
})
