import { describe, expect, it } from 'vitest'
import { localizeRunConfigForHost } from './execution-session.js'

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
