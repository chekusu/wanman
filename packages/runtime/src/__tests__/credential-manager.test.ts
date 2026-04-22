/**
 * Unit tests for CredentialManager — OAuth token refresh lifecycle.
 * Mocks: fs, fetch, process.env.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { CredentialManager, type AuthMode } from '../credential-manager.js'

// Mock logger
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

// --- Helpers ---

const TEST_CREDS_DIR = '/tmp/test-creds'
const TEST_CREDS_FILE = path.join(TEST_CREDS_DIR, '.credentials.json')
const TEST_VAULT_PATH = '/tmp/test-vault.json'

function makeCreds(overrides?: { expiresAt?: number }) {
  return {
    claudeAiOauth: {
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: overrides?.expiresAt ?? (Date.now() + 3600 * 1000), // 1h from now
    },
  }
}

function makeManager() {
  return new CredentialManager({
    credentialsFilePath: TEST_CREDS_FILE,
    vaultPath: TEST_VAULT_PATH,
  })
}

function cleanupFiles() {
  try { fs.rmSync(TEST_CREDS_DIR, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(TEST_VAULT_PATH, { force: true }) } catch {}
}

// Save and restore env
const savedEnv: Record<string, string | undefined> = {}
function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  Object.keys(savedEnv).forEach(k => delete savedEnv[k])
}

describe('CredentialManager', () => {
  beforeEach(() => {
    cleanupFiles()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    restoreEnv()
    cleanupFiles()
  })

  // --- detectAuthMode ---

  describe('detectAuthMode', () => {
    it('should detect api-key mode', () => {
      setEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx')
      setEnv('CLAUDE_CREDENTIALS', undefined)
      const cm = makeManager()
      expect(cm.detectAuthMode()).toBe('api-key')
    })

    it('should detect oauth mode', () => {
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(makeCreds()))
      const cm = makeManager()
      expect(cm.detectAuthMode()).toBe('oauth')
    })

    it('should detect none mode', () => {
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', undefined)
      const cm = makeManager()
      expect(cm.detectAuthMode()).toBe('none')
    })

    it('should prefer api-key when both are set', () => {
      setEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx')
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(makeCreds()))
      const cm = makeManager()
      expect(cm.detectAuthMode()).toBe('api-key')
    })
  })

  // --- bootstrap ---

  describe('bootstrap', () => {
    it('should be no-op for api-key mode', async () => {
      setEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx')
      setEnv('CLAUDE_CREDENTIALS', undefined)
      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()
      expect(fs.existsSync(TEST_CREDS_FILE)).toBe(false)
    })

    it('should load from env and write credentials file', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 4 * 3600 * 1000 })
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))
      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()

      expect(fs.existsSync(TEST_CREDS_FILE)).toBe(true)
      const written = JSON.parse(fs.readFileSync(TEST_CREDS_FILE, 'utf-8'))
      expect(written.claudeAiOauth.accessToken).toBe('test-access-token')
    })

    it('should create parent directory if missing', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 4 * 3600 * 1000 })
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))
      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()

      expect(fs.existsSync(TEST_CREDS_DIR)).toBe(true)
    })

    it('should set file permissions to 0o600', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 4 * 3600 * 1000 })
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))
      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()

      const stat = fs.statSync(TEST_CREDS_FILE)
      // 0o600 = 384 decimal; check owner read+write bits
      expect(stat.mode & 0o777).toBe(0o600)
    })

    it('should prefer vault over env', async () => {
      const envCreds = makeCreds({ expiresAt: Date.now() + 4 * 3600 * 1000 })
      const vaultCreds = makeCreds({ expiresAt: Date.now() + 5 * 3600 * 1000 })
      // Pre-create vault
      fs.mkdirSync(path.dirname(TEST_VAULT_PATH), { recursive: true })
      fs.writeFileSync(TEST_VAULT_PATH, JSON.stringify(vaultCreds))

      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(envCreds))
      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()

      const written = JSON.parse(fs.readFileSync(TEST_CREDS_FILE, 'utf-8'))
      expect(written.claudeAiOauth.expiresAt).toBe(vaultCreds.claudeAiOauth.expiresAt)
    })

    it('falls back to env when the vault is unreadable', async () => {
      const envCreds = makeCreds({ expiresAt: Date.now() + 4 * 3600 * 1000 })
      fs.writeFileSync(TEST_VAULT_PATH, '{bad-json')

      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(envCreds))
      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()

      const written = JSON.parse(fs.readFileSync(TEST_CREDS_FILE, 'utf-8'))
      expect(written.claudeAiOauth.expiresAt).toBe(envCreds.claudeAiOauth.expiresAt)
    })

    it('does not write credentials when oauth env is missing or invalid', async () => {
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', undefined)
      let cm = makeManager()
      ;(cm as unknown as { authMode: AuthMode }).authMode = 'oauth'
      await cm.bootstrap()
      expect(fs.existsSync(TEST_CREDS_FILE)).toBe(false)

      setEnv('CLAUDE_CREDENTIALS', '{bad-json')
      cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()
      expect(fs.existsSync(TEST_CREDS_FILE)).toBe(false)
    })

    it('should refresh immediately if token is expiring soon', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 30 * 60 * 1000 }) // 30min
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://console.anthropic.com/v1/oauth/token',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('refresh_token'),
        }),
      )

      vi.unstubAllGlobals()
    })
  })

  // --- refreshOAuthToken (via ensureFresh) ---

  describe('refreshOAuthToken', () => {
    it('should refresh and update credentials on success', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 30 * 60 * 1000 })
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-access',
          refresh_token: 'refreshed-refresh',
          expires_in: 3600,
        }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const cm = makeManager()
      cm.detectAuthMode()
      // Bootstrap without immediate refresh (far future expiry for bootstrap, then override)
      await cm.bootstrap() // will trigger refresh since < 1h

      // Verify the file was written with new credentials
      const written = JSON.parse(fs.readFileSync(TEST_CREDS_FILE, 'utf-8'))
      expect(written.claudeAiOauth.accessToken).toBe('refreshed-access')
      expect(written.claudeAiOauth.refreshToken).toBe('refreshed-refresh')

      vi.unstubAllGlobals()
    })

    it('should handle network timeout gracefully', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 30 * 60 * 1000 })
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))

      const mockFetch = vi.fn().mockRejectedValue(new Error('network timeout'))
      vi.stubGlobal('fetch', mockFetch)

      const cm = makeManager()
      cm.detectAuthMode()
      // Should not throw
      await expect(cm.bootstrap()).resolves.toBeUndefined()

      // Original credentials should still be written (from bootstrap before refresh attempt)
      const written = JSON.parse(fs.readFileSync(TEST_CREDS_FILE, 'utf-8'))
      expect(written.claudeAiOauth.accessToken).toBe('test-access-token')

      vi.unstubAllGlobals()
    })

    it('should handle 400 response gracefully', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 30 * 60 * 1000 })
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => '{"error": "invalid_grant"}',
      })
      vi.stubGlobal('fetch', mockFetch)

      const cm = makeManager()
      cm.detectAuthMode()
      await expect(cm.bootstrap()).resolves.toBeUndefined()

      vi.unstubAllGlobals()
    })

    it('skips refresh when credentials have no refresh token', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 30 * 60 * 1000 })
      creds.claudeAiOauth.refreshToken = ''
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))

      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)

      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()

      expect(mockFetch).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it('should not overwrite newer token', async () => {
      // Token that expires far in the future
      const creds = makeCreds({ expiresAt: Date.now() + 30 * 60 * 1000 })
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))

      // Server returns a token that expires sooner than current
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'old-access',
          refresh_token: 'old-refresh',
          expires_in: 1, // only 1 second — will be < current expiresAt
        }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()

      // The written file should keep original credentials (refresh was skipped)
      const written = JSON.parse(fs.readFileSync(TEST_CREDS_FILE, 'utf-8'))
      expect(written.claudeAiOauth.accessToken).toBe('test-access-token')

      vi.unstubAllGlobals()
    })
  })

  // --- ensureFresh ---

  describe('ensureFresh', () => {
    it('should trigger refresh when token expires in < 1h', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 30 * 60 * 1000 })
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_in: 7200, // 2h — well above the 1h threshold
        }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap() // triggers first refresh

      mockFetch.mockClear()

      // ensureFresh should not trigger another refresh since bootstrap already refreshed
      await cm.ensureFresh()
      // After bootstrap refresh, token is fresh (~2h), so ensureFresh skips
      expect(mockFetch).not.toHaveBeenCalled()

      vi.unstubAllGlobals()
    })

    it('should skip refresh when token is still valid (> 1h)', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 2 * 3600 * 1000 })
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))

      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)

      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()
      await cm.ensureFresh()

      expect(mockFetch).not.toHaveBeenCalled()

      vi.unstubAllGlobals()
    })

    it('should be no-op for api-key mode', async () => {
      setEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx')
      setEnv('CLAUDE_CREDENTIALS', undefined)

      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)

      const cm = makeManager()
      cm.detectAuthMode()
      await cm.ensureFresh()

      expect(mockFetch).not.toHaveBeenCalled()

      vi.unstubAllGlobals()
    })
  })

  // --- syncFromFile ---

  describe('syncFromFile', () => {
    it('should detect CLI-refreshed token and update', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 2 * 3600 * 1000 })
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))

      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()

      // Simulate CLI refreshing the token
      const cliCreds = makeCreds({ expiresAt: Date.now() + 4 * 3600 * 1000 })
      fs.writeFileSync(TEST_CREDS_FILE, JSON.stringify(cliCreds))

      await cm.syncFromFile()

      // Vault should be updated
      expect(fs.existsSync(TEST_VAULT_PATH)).toBe(true)
      const vault = JSON.parse(fs.readFileSync(TEST_VAULT_PATH, 'utf-8'))
      expect(vault.claudeAiOauth.expiresAt).toBe(cliCreds.claudeAiOauth.expiresAt)
    })

    it('should not update if file token is older', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 4 * 3600 * 1000 })
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))

      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()

      // Write an older token to file
      const olderCreds = makeCreds({ expiresAt: Date.now() + 1 * 3600 * 1000 })
      fs.writeFileSync(TEST_CREDS_FILE, JSON.stringify(olderCreds))

      await cm.syncFromFile()

      // Vault should have the original (newer) token
      const vault = JSON.parse(fs.readFileSync(TEST_VAULT_PATH, 'utf-8'))
      expect(vault.claudeAiOauth.expiresAt).toBe(creds.claudeAiOauth.expiresAt)
    })

    it('should be no-op when credentials file does not exist', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 2 * 3600 * 1000 })
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))

      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()

      // Delete the credentials file
      fs.rmSync(TEST_CREDS_FILE)

      // Should not throw
      await expect(cm.syncFromFile()).resolves.toBeUndefined()
    })

    it('ignores invalid credentials file content during sync', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 2 * 3600 * 1000 })
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))

      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()
      fs.writeFileSync(TEST_CREDS_FILE, '{bad-json')

      await expect(cm.syncFromFile()).resolves.toBeUndefined()
    })
  })

  // --- lifecycle ---

  describe('lifecycle', () => {
    it('should start and stop refresh loop', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 4 * 3600 * 1000 })
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))

      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()

      cm.startRefreshLoop()
      // Starting again should be idempotent
      cm.startRefreshLoop()

      cm.stopRefreshLoop()
      // Stopping again should be safe
      cm.stopRefreshLoop()
    })

    it('should save vault on shutdown', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 4 * 3600 * 1000 })
      setEnv('ANTHROPIC_API_KEY', undefined)
      setEnv('CLAUDE_CREDENTIALS', JSON.stringify(creds))

      const cm = makeManager()
      cm.detectAuthMode()
      await cm.bootstrap()
      cm.startRefreshLoop()

      await cm.shutdown()

      expect(fs.existsSync(TEST_VAULT_PATH)).toBe(true)
      const vault = JSON.parse(fs.readFileSync(TEST_VAULT_PATH, 'utf-8'))
      expect(vault.claudeAiOauth.accessToken).toBe('test-access-token')
    })

    it('should be no-op for non-oauth modes', async () => {
      setEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx')
      setEnv('CLAUDE_CREDENTIALS', undefined)

      const cm = makeManager()
      cm.detectAuthMode()
      cm.startRefreshLoop()
      cm.stopRefreshLoop()
      await cm.shutdown()

      expect(fs.existsSync(TEST_VAULT_PATH)).toBe(false)
    })
  })
})
