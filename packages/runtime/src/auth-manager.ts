/**
 * AuthManager — detects installed CLI tools, checks auth status,
 * and orchestrates interactive login flows (capturing URL + pairing code).
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import type { AuthProviderName, AuthProviderInfo, AuthStatus } from '@wanman/core';
import { createLogger } from './logger.js';

const log = createLogger('auth-manager');
const AUTH_CHECK_TIMEOUT_MS = 1500;

/** Active login session for a provider */
interface LoginSession {
  provider: AuthProviderName;
  status: AuthStatus;
  loginUrl?: string;
  loginCode?: string;
  error?: string;
  process?: ChildProcess;
}

/** Provider-specific detection and login configuration */
interface ProviderConfig {
  /** Command + args to check if the CLI is authenticated */
  checkCmd: [string, ...string[]];
  /** Command + args to start interactive login */
  loginCmd?: [string, ...string[]];
  /** Regex to extract the pairing/one-time code from stdout */
  codeRegex?: RegExp;
  /** Regex to extract the login URL from stdout */
  urlRegex?: RegExp;
  /** Alternative: check env var instead of spawning a process */
  envVar?: string;
  /** Custom check function (overrides checkCmd / envVar) */
  customCheck?: () => boolean;
}

/** Check if Claude Code has valid credentials (API key or OAuth). */
function checkClaudeAuth(): boolean {
  // Mode 1: API key
  if (process.env['ANTHROPIC_API_KEY']) return true;

  // Mode 2: OAuth credentials env var
  if (process.env['CLAUDE_CREDENTIALS']) return true;

  // Mode 3: OAuth credentials file on disk
  const home = process.env['HOME'] || '/root';
  const credFile = path.join(home, '.claude', '.credentials.json');
  try {
    if (fs.existsSync(credFile)) {
      const raw = fs.readFileSync(credFile, 'utf-8');
      const creds = JSON.parse(raw) as { claudeAiOauth?: { expiresAt?: number } };
      // Check if token is not yet expired
      const expiresAt = creds.claudeAiOauth?.expiresAt ?? 0;
      return expiresAt > Date.now();
    }
  } catch { /* ignore */ }

  return false;
}

/** Check if Codex has valid credentials (API key or ChatGPT auth.json). */
function checkCodexAuth(): boolean {
  if (process.env['OPENAI_API_KEY']) return true;

  const home = process.env['HOME'] || '/root';
  const authFile = path.join(home, '.codex', 'auth.json');
  try {
    if (fs.existsSync(authFile)) {
      const raw = fs.readFileSync(authFile, 'utf-8');
      const auth = JSON.parse(raw) as { tokens?: { access_token?: string } };
      return !!auth.tokens?.access_token;
    }
  } catch { /* ignore */ }

  return false;
}

export const SUPPORTED_AUTH_PROVIDERS = ['claude', 'codex', 'github'] as const satisfies readonly AuthProviderName[];

export function isAuthProviderName(value: unknown): value is AuthProviderName {
  return typeof value === 'string' && (SUPPORTED_AUTH_PROVIDERS as readonly string[]).includes(value);
}

const PROVIDER_CONFIGS: Record<AuthProviderName, ProviderConfig> = {
  github: {
    checkCmd: ['gh', 'auth', 'status'],
    loginCmd: ['gh', 'auth', 'login', '-h', 'github.com', '-p', 'https', '-w'],
    codeRegex: /one-time code(?:.*?): (\S+)/i,
    urlRegex: /https:\/\/\S+/,
  },
  claude: {
    checkCmd: ['claude', '--version'],
    customCheck: checkClaudeAuth,
    loginCmd: ['claude', 'auth', 'login'],
    urlRegex: /https?:\/\/\S+/,
  },
  codex: {
    checkCmd: ['codex', 'login', 'status'],
    customCheck: checkCodexAuth,
    loginCmd: ['codex', 'login', '--device-auth'],
    codeRegex: /([A-Z0-9]{4}-[A-Z0-9]{4,5})/,
    urlRegex: /https:\/\/auth\.openai\.com\/\S+/,
  },
};

export class AuthManager {
  private sessions: Map<AuthProviderName, LoginSession> = new Map();

  /** Get all providers and their current auth status */
  async getProviders(): Promise<AuthProviderInfo[]> {
    const results: AuthProviderInfo[] = [];

    for (const name of SUPPORTED_AUTH_PROVIDERS) {
      // If there's an active login session, return that
      const session = this.sessions.get(name);
      if (session && session.status === 'pending') {
        results.push({
          name,
          status: session.status,
          loginUrl: session.loginUrl,
          loginCode: session.loginCode,
        });
        continue;
      }

      const authenticated = await this.checkAuth(name);
      results.push({
        name,
        status: authenticated ? 'authenticated' : 'unauthenticated',
      });
    }

    return results;
  }

  /** Check if a single provider is authenticated */
  async checkAuth(provider: AuthProviderName): Promise<boolean> {
    const config = PROVIDER_CONFIGS[provider];

    // Custom check function (claude)
    if (config.customCheck) {
      return config.customCheck();
    }

    // Env-var-based check
    if (config.envVar) {
      return !!process.env[config.envVar];
    }

    // CLI-based check
    try {
      const exitCode = await this.spawnAndWait(config.checkCmd[0], config.checkCmd.slice(1), true);
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  /** Start an interactive login flow, capturing URL and code from stdout */
  async startLogin(provider: AuthProviderName): Promise<AuthProviderInfo> {
    const config = PROVIDER_CONFIGS[provider];

    if (!config.loginCmd) {
      return {
        name: provider,
        status: 'error',
        error: `Provider "${provider}" does not support CLI login. Use API token instead.`,
      };
    }

    // If already pending, return the current session
    const existing = this.sessions.get(provider);
    if (existing && existing.status === 'pending') {
      return {
        name: provider,
        status: 'pending',
        loginUrl: existing.loginUrl,
        loginCode: existing.loginCode,
      };
    }

    const session: LoginSession = {
      provider,
      status: 'pending',
    };
    this.sessions.set(provider, session);

    log.info('starting login', { provider });

    const [cmd, ...args] = config.loginCmd;

    return new Promise<AuthProviderInfo>((resolve) => {
      const child: ChildProcess = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      session.process = child;
      let resolved = false;

      const processOutput = (data: Buffer) => {
        const text = data.toString();
        log.debug('login stdout', { provider, text: text.trim() });

        // Try to extract code
        if (config.codeRegex && !session.loginCode) {
          const codeMatch = text.match(config.codeRegex);
          if (codeMatch) {
            session.loginCode = codeMatch[1];
          }
        }

        // Try to extract URL
        if (config.urlRegex && !session.loginUrl) {
          const urlMatch = text.match(config.urlRegex);
          if (urlMatch) {
            session.loginUrl = urlMatch[0];
          }
        }

        // Once we have URL (and optionally code), resolve
        if (!resolved && session.loginUrl) {
          resolved = true;
          resolve({
            name: provider,
            status: 'pending',
            loginUrl: session.loginUrl,
            loginCode: session.loginCode,
          });
        }
      };

      child.stdout?.on('data', processOutput);
      child.stderr?.on('data', processOutput);

      child.on('error', (err: Error) => {
        log.error('login spawn error', { provider, error: err.message });
        if (!resolved) {
          resolved = true;
          session.status = 'error';
          session.error = `Failed to spawn login process: ${err.message}`;
          resolve({
            name: provider,
            status: 'error',
            error: session.error,
          });
        }
      });

      child.on('close', (code: number | null) => {
        log.info('login process exited', { provider, code });

        if (code === 0) {
          session.status = 'authenticated';
        } else if (session.status === 'pending') {
          session.status = 'error';
          session.error = `Login process exited with code ${code}`;
        }

        // If we never resolved (e.g., process exited before printing URL), resolve now
        if (!resolved) {
          resolved = true;
          resolve({
            name: provider,
            status: session.status,
            loginUrl: session.loginUrl,
            loginCode: session.loginCode,
            error: session.error,
          });
        }
      });

      // Timeout after 5 minutes
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          session.status = 'error';
          session.error = 'Login timed out after 5 minutes';
          child.kill();
          resolve({
            name: provider,
            status: 'error',
            error: session.error,
          });
        }
      }, 5 * 60 * 1000);
      timeout.unref();
    });
  }

  /** Get the current login status for a provider */
  getLoginStatus(provider: AuthProviderName): AuthProviderInfo {
    const session = this.sessions.get(provider);
    if (!session) {
      return { name: provider, status: 'unauthenticated' };
    }
    return {
      name: provider,
      status: session.status,
      loginUrl: session.loginUrl,
      loginCode: session.loginCode,
      error: session.error,
    };
  }

  /** Spawn a command and wait for exit code */
  private spawnAndWait(cmd: string, args: string[], silent: boolean): Promise<number> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const child: ChildProcess = spawn(cmd, args, {
        stdio: silent ? 'ignore' : 'inherit',
        env: { ...process.env },
      });
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve(1);
      }, AUTH_CHECK_TIMEOUT_MS);
      timeout.unref?.();
      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(code ?? 1);
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}
