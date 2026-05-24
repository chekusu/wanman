import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractEnvReferences, scanApiKeyInventory } from '../key-inventory.js'

describe('key inventory', () => {
  it('extracts credential env names without values', () => {
    const refs = extractEnvReferences(`
      OPENAI_API_KEY=not-a-real-secret-value
      const key = process.env.STRIPE_SECRET_KEY
      token = os.environ.get("GITHUB_TOKEN")
      api = Deno.env.get("ANTHROPIC_API_KEY")
      uses: \${{ secrets.CLOUDFLARE_API_TOKEN }}
    `)

    expect(refs.map((ref) => ref.envVar)).toEqual(expect.arrayContaining([
      'OPENAI_API_KEY',
      'STRIPE_SECRET_KEY',
      'GITHUB_TOKEN',
      'ANTHROPIC_API_KEY',
      'CLOUDFLARE_API_TOKEN',
    ]))
    expect(JSON.stringify(refs)).not.toContain('not-a-real-secret-value')
  })

  it('scans repos and summarizes by product and company', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wanman-finops-'))
    const owner = path.join(root, 'chekusu')
    const repo = path.join(owner, 'alpha')
    await fs.mkdir(path.join(repo, '.git'), { recursive: true })
    await fs.mkdir(path.join(repo, 'src'), { recursive: true })
    await fs.writeFile(path.join(repo, '.env.example'), 'OPENAI_API_KEY=\nSTRIPE_SECRET_KEY=\n')
    await fs.writeFile(path.join(repo, 'src', 'index.ts'), 'process.env.RESEND_API_KEY\n')

    const inventory = await scanApiKeyInventory({
      root: owner,
      companyId: 'jpco',
      config: {
        company: { id: 'jpco' },
        products: [{ id: 'alpha-product', repositories: ['chekusu/alpha'] }],
      },
    })

    expect(inventory.reposScanned).toBe(1)
    expect(inventory.references).toHaveLength(3)
    expect(inventory.references.every((ref) => ref.secretIncluded === false)).toBe(true)
    expect(inventory.byProduct['alpha-product']?.providers).toMatchObject({
      openai: 1,
      stripe: 1,
      resend: 1,
    })
    expect(inventory.byCompany['jpco']?.productCount).toBe(1)
  })

  it('uses code evidence to distinguish OpenAI-compatible OpenRouter billing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wanman-finops-'))
    const owner = path.join(root, 'chekusu')
    const repo = path.join(owner, 'router-app')
    await fs.mkdir(path.join(repo, '.git'), { recursive: true })
    await fs.mkdir(path.join(repo, 'src'), { recursive: true })
    await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({
      dependencies: { openai: '^5.0.0' },
    }))
    await fs.writeFile(path.join(repo, 'src', 'client.ts'), `
      import OpenAI from 'openai'
      export const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
      })
    `)
    await fs.writeFile(path.join(repo, 'src', 'config.ts'), 'export const key = process.env.INTERNAL_API_KEY\n')

    const inventory = await scanApiKeyInventory({
      root: owner,
      companyId: 'jpco',
    })

    const ref = inventory.references.find((item) => item.envVar === 'OPENAI_API_KEY')
    expect(ref).toEqual(expect.objectContaining({
      credentialProvider: 'openai',
      provider: 'openrouter',
      secretIncluded: false,
    }))
    expect(ref?.providerEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'sdk-import', value: 'import:openai', provider: 'openai' }),
      expect.objectContaining({ kind: 'base-url', value: 'host:openrouter.ai', provider: 'openrouter' }),
      expect.objectContaining({ kind: 'package-name', value: 'package:openai', provider: 'openai' }),
    ]))
    expect(inventory.references.find((item) => item.envVar === 'INTERNAL_API_KEY')).toEqual(expect.objectContaining({
      provider: 'unknown',
      credentialProvider: 'unknown',
    }))
    expect(JSON.stringify(ref)).not.toContain('sk-')
  })
})
