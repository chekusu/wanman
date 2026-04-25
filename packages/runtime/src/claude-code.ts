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

/**
 * Patterns Claude Code emits when `--resume <id>` references a session the
 * local CLI no longer has. Recorded across versions:
 *
 * - 2.1.119+ (stdout `result` event errors / stderr): `No conversation found with session ID: <id>`
 * - older / alt wordings:                              `No session found`, `session not found`,
 *                                                      `session does not exist`, `session unavailable`,
 *                                                      `could not resume`, `could not find session`,
 *                                                      `conversation not found`
 *
 * The CLI wording has shifted at least once already (`session` → `conversation`),
 * so the match is intentionally permissive on either noun. Keep this list
 * here, not inlined, so future CLI wording bumps add one regex alternative
 * instead of grepping the file. If patterns drift further, the structured
 * `result.errors` payload (also matched against this regex) is the more
 * stable surface — we already check that channel.
 */
const RESUME_MISSING_PATTERN =
  /no\s+(?:conversation|session)\s+found|(?:conversation|session)\s+(?:not\s+found|does\s+not\s+exist|unavailable)|could\s+not\s+(?:resume|find\s+(?:conversation|session))/i;

/**
 * Pull every plausible error-text field off a Claude `result` event and
 * concatenate them. Claude emits errors in a few shapes depending on
 * subtype: as `result` (string), `errors` (array of strings or objects),
 * or `error` (single string). We check all of them so the resume-miss
 * regex catches the message wherever the CLI puts it that day.
 */
function resultErrorText(event: ClaudeEvent): string {
  const parts: string[] = [];
  if (typeof event.result === 'string' && event.result.trim()) parts.push(event.result.trim());
  const errors = (event as Record<string, unknown>)['errors'];
  if (Array.isArray(errors)) {
    for (const err of errors) {
      if (typeof err === 'string' && err.trim()) parts.push(err.trim());
      else if (err && typeof err === 'object') {
        const message = (err as Record<string, unknown>)['message'];
        if (typeof message === 'string' && message.trim()) parts.push(message.trim());
      }
    }
  }
  const error = (event as Record<string, unknown>)['error'];
  if (typeof error === 'string' && error.trim()) parts.push(error.trim());
  return parts.join(' | ');
}

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
  /**
   * Register a handler invoked when Claude reports its session id (via the
   * `system/init` event). Use this to persist the id and pass it back as
   * `resumeSessionId` on the next spawn.
   */
  onSessionId(handler: (sessionId: string) => void): void;
  /** Register a handler for process exit */
  onExit(handler: (code: number) => void): void;
  /**
   * True iff Claude refused to resume the requested `resumeSessionId`
   * (i.e. the session was not found locally). Callers can check this after
   * exit and retry the spawn without `resumeSessionId` for cold-start
   * recovery.
   */
  resumeMissed(): boolean;
}

export interface SpawnOptions {
  model: ModelTier;
  systemPrompt: string;
  cwd: string;
  /** Initial user message to send immediately after spawn */
  initialMessage?: string;
  sessionId?: string;
  /**
   * If set, append `--resume <id>` to the Claude CLI args so the new process
   * picks up where the previous process left off. The previous run's session
   * id is reported via `onSessionId`. If the local Claude session store has
   * dropped the id (rotated, manually deleted, etc.) the spawn surfaces this
   * via `resumeMissed()` so the caller can retry without the flag.
   */
  resumeSessionId?: string;
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
  const { model, systemPrompt, cwd, initialMessage, sessionId, resumeSessionId } = opts;

  const claudeArgs = [
    '--model', model,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--verbose',
    '--system-prompt', systemPrompt,
  ];

  if (resumeSessionId) {
    claudeArgs.push('--resume', resumeSessionId);
  }

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
  const sessionIdHandlers: Array<(sessionId: string) => void> = [];
  const exitHandlers: Array<(code: number) => void> = [];
  let observedSessionId: string | null = null;
  let resumeMissed = false;

  // Parse JSONL from stdout
  let rl: ReadlineInterface | null = null;
  if (proc.stdout) {
    rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line.trim()) as ClaudeEvent;
        for (const handler of eventHandlers) handler(event);

        // Capture the session id from system/init so callers can persist it
        // for `resumeSessionId` on the next spawn.
        if (
          event.type === 'system'
          && event.subtype === 'init'
          && typeof event.session_id === 'string'
          && event.session_id
          && observedSessionId !== event.session_id
        ) {
          observedSessionId = event.session_id;
          for (const handler of sessionIdHandlers) handler(event.session_id);
        }

        // Detect final result
        if (event.type === 'result') {
          const text = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
          for (const handler of resultHandlers) handler(text, event.is_error ?? false);

          // Claude Code 2.1.119+ surfaces the stale-resume failure on the
          // structured `result` event (is_error + "No conversation found
          // with session ID: ..."), not just stderr. Detecting it here is
          // more stable than grepping stderr because the JSONL contract is
          // versioned by Anthropic, while the stderr text has already
          // shifted once (`session` → `conversation`).
          if (
            resumeSessionId
            && !resumeMissed
            && event.is_error === true
          ) {
            const errorText = resultErrorText(event);
            if (errorText && RESUME_MISSING_PATTERN.test(errorText)) {
              resumeMissed = true;
              log.warn('resume session missing (result event)', { resumeSessionId, text: errorText.slice(0, 200) });
            }
          }
        }
      } catch {
        // Skip unparseable lines
      }
    });
  }

  // Log stderr — and watch for the same "session/conversation not found"
  // signal as a fallback in case the CLI version writes the failure to
  // stderr instead of (or in addition to) the JSONL result event.
  if (proc.stderr) {
    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (!text) return;
      if (
        resumeSessionId
        && !resumeMissed
        && RESUME_MISSING_PATTERN.test(text)
      ) {
        resumeMissed = true;
        log.warn('resume session missing (stderr)', { resumeSessionId, text: text.slice(0, 200) });
      }
      log.warn('stderr', { text: text.slice(0, 500) });
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
    onSessionId(handler) {
      sessionIdHandlers.push(handler);
      if (observedSessionId) handler(observedSessionId);
    },
    onExit(handler) { exitHandlers.push(handler); },
    resumeMissed() { return resumeMissed; },
  };

  // Send initial message if provided
  if (initialMessage) {
    handle.sendMessage(initialMessage);
    // For single-shot, end stdin after the initial message
    // For continuous mode (24/7 agents), we keep stdin open for steer messages
  }

  return handle;
}
