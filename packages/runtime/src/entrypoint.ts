/**
 * Container entrypoint — loads config, creates workspace directories,
 * initializes Supervisor, and handles signals.
 */

import { Supervisor } from './supervisor.js';
import { CredentialManager } from './credential-manager.js';
import { loadConfig, ensureWorkspaceDirs } from './config.js';
import { AuthManager } from './auth-manager.js';
import { createLogger } from './logger.js';

const log = createLogger('entrypoint');

async function main(): Promise<void> {
  log.info('wanman agent matrix starting...');

  // Decode WANMAN_GOAL_B64 into WANMAN_GOAL so downstream code that reads
  // process.env.WANMAN_GOAL keeps working without ever having to pass the
  // raw goal through a shell.
  const goalB64 = process.env['WANMAN_GOAL_B64'];
  if (goalB64 && !process.env['WANMAN_GOAL']) {
    try {
      process.env['WANMAN_GOAL'] = Buffer.from(goalB64, 'base64').toString('utf-8');
    } catch (err) {
      log.warn('failed to decode WANMAN_GOAL_B64', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const config = loadConfig();
  log.info('config loaded', {
    agents: config.agents.map(a => `${a.name} (${a.lifecycle})`),
    dbPath: config.dbPath,
    port: config.port,
  });

  ensureWorkspaceDirs(config);

  // Initialize credential manager
  const credentialManager = new CredentialManager();
  const authMode = credentialManager.detectAuthMode();
  log.info('auth mode detected', { authMode });

  if (authMode === 'oauth') {
    await credentialManager.bootstrap();
    credentialManager.startRefreshLoop();
  }

  // Detect CLI auth status at startup
  const authManager = new AuthManager();
  const providers = await authManager.getProviders();
  for (const p of providers) {
    log.info('cli auth status', { provider: p.name, status: p.status });
  }

  const headless = process.env['WANMAN_HEADLESS'] === '1';
  const supervisor = new Supervisor(config, { credentialManager, headless });
  await supervisor.start();

  // Signal handling (idempotent — ignore duplicate signals)
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('received signal', { signal });
    await credentialManager.shutdown();
    await supervisor.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log.info('agent matrix running');
}

main().catch((err) => {
  log.error('fatal error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
