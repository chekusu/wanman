/**
 * Claude Code CLI spawn wrapper.
 *
 * Spawns a `claude` process with stream-json I/O, parses JSONL events
 * from stdout, and provides methods to send messages and kill the process.
 */

import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import type { ModelTier } from '@wanman/core';
import { createLogger } from './logger.js';

const log = createLogger('claude-code');

/** Events emitted by the Claude Code process via JSONL stdout */
export interface ClaudeEvent extends Record<string, unknown> {
  type: string;
  subtype?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  result?: string;
  cost_usd?: number;
  duration_ms?: number;
  is_error?: boolean;
  message?: unknown;
  session_id?: string;
}

export interface ClaudeCodeProcess {
  /** The underlying child process */
  proc: ChildProcess;
  /** Send a user message via stdin (stream-json format) */
  sendMessage(content: string, sessionId?: string): void;
  /** Kill the process */
  kill(): void;
  /** Wait for the process to exit. Returns the exit code. */
  wait(): Promise<number>;
  /** Register a handler for parsed JSONL events */
  onEvent(handler: (event: ClaudeEvent) => void): void;
  /** Register a handler for the final result */
  onResult(handler: (result: string, isError: boolean) => void): void;
  /** Register a handler for process exit */
  onExit(handler: (code: number) => void): void;
}

export interface SpawnOptions {
  model: ModelTier;
  systemPrompt: string;
  cwd: string;
  /** Initial user message to send immediately after spawn */
  initialMessage?: string;
  sessionId?: string;
  /** Extra environment variables to inject into the spawned process */
  env?: Record<string, string>;
  /** Run claude as this user (via runuser). When unset, runs as current user. */
  runAsUser?: string;
}

/**
 * Spawn a Claude Code CLI process.
 *
 * The process uses `--input-format stream-json` so we can write multiple
 * messages to stdin over time, and `--output-format stream-json` so we
 * get structured JSONL on stdout.
 */
export function spawnClaudeCode(opts: SpawnOptions): ClaudeCodeProcess {
  const { model, systemPrompt, cwd, initialMessage, sessionId } = opts;

  const claudeArgs = [
    '--model', model,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--verbose',
    '--system-prompt', systemPrompt,
  ];

  // When running as root and runAsUser is set, use runuser to switch user
  const runAsUser = opts.runAsUser;
  const useRunuser = runAsUser && process.getuid?.() === 0;
  const cmd = useRunuser ? 'runuser' : 'claude';
  const args = useRunuser
    ? ['-u', runAsUser, '--', 'claude', ...claudeArgs]
    : claudeArgs;

  log.info('spawning', { model, cwd, ...(useRunuser ? { runAsUser } : {}) });

  const proc = spawn(cmd, args, {
    cwd,
    env: {
      ...process.env,
      // Force bash shell — prevents zsh glob expansion breaking paths like (auth)/
      SHELL: '/bin/bash',
      // Fix HOME for runuser: Claude Code needs correct home for session-env, settings, etc.
      ...(useRunuser ? { HOME: `/home/${runAsUser}` } : {}),
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ...opts.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const eventHandlers: Array<(event: ClaudeEvent) => void> = [];
  const resultHandlers: Array<(result: string, isError: boolean) => void> = [];
  const exitHandlers: Array<(code: number) => void> = [];

  // Parse JSONL from stdout
  let rl: ReadlineInterface | null = null;
  if (proc.stdout) {
    rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line.trim()) as ClaudeEvent;
        for (const handler of eventHandlers) handler(event);

        // Detect final result
        if (event.type === 'result') {
          const text = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
          for (const handler of resultHandlers) handler(text, event.is_error ?? false);
        }
      } catch {
        // Skip unparseable lines
      }
    });
  }

  // Log stderr
  if (proc.stderr) {
    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) log.warn('stderr', { text: text.slice(0, 500) });
    });
  }

  // Handle spawn errors (e.g. binary not found) — must be caught to avoid crashing the process
  proc.on('error', (err) => {
    log.error('spawn error', { error: err.message });
    for (const handler of exitHandlers) handler(1);
  });

  proc.on('close', (code) => {
    const exitCode = code ?? 1;
    log.info('exited', { code: exitCode });
    for (const handler of exitHandlers) handler(exitCode);
  });

  const handle: ClaudeCodeProcess = {
    proc,

    sendMessage(content: string, sid?: string): void {
      if (!proc.stdin || proc.stdin.destroyed) {
        log.warn('stdin destroyed, cannot send message');
        return;
      }
      const msg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content },
        session_id: sid ?? sessionId ?? 'default',
      });
      proc.stdin.write(msg + '\n');
    },

    kill(): void {
      if (!proc.killed) {
        log.info('killing process');
        proc.kill('SIGTERM');
        // Force kill after 5s
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
      }
    },

    wait(): Promise<number> {
      return new Promise((resolve) => {
        if (proc.exitCode !== null) {
          resolve(proc.exitCode);
          return;
        }
        proc.on('close', (code) => resolve(code ?? 1));
        proc.on('error', () => resolve(1));
      });
    },

    onEvent(handler) { eventHandlers.push(handler); },
    onResult(handler) { resultHandlers.push(handler); },
    onExit(handler) { exitHandlers.push(handler); },
  };

  // Send initial message if provided
  if (initialMessage) {
    handle.sendMessage(initialMessage);
    // For single-shot, end stdin after the initial message
    // For continuous mode (24/7 agents), we keep stdin open for steer messages
  }

  return handle;
}
