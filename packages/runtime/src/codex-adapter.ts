import { spawn } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { createLogger } from './logger.js';
import type { AgentAdapter, AgentRunEvent, AgentRunHandle, AgentRunOptions } from './agent-adapter.js';

const log = createLogger('codex-adapter');

interface CodexResult {
  text: string;
  isError: boolean;
}

function normalizeCodexModel(model: string): string | null {
  if (/^(gpt-|o[1-9]|codex)/i.test(model)) return model;
  return null;
}

function normalizeCodexReasoningEffort(value?: string): 'low' | 'medium' | 'high' | 'xhigh' | null {
  if (!value) return null;
  switch (value.trim().toLowerCase()) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value.trim().toLowerCase() as 'low' | 'medium' | 'high' | 'xhigh';
    default:
      return null;
  }
}

function buildPrompt(systemPrompt: string, initialMessage?: string): string {
  const task = initialMessage?.trim() || 'Start working.';
  return `Follow these instructions exactly.\n\n<System>\n${systemPrompt}\n</System>\n\n<User>\n${task}\n</User>`;
}

function pickString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pickString(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['text', 'output_text', 'message', 'content']) {
    const found = pickString(record[key]);
    if (found) return found;
  }
  return null;
}

function extractResult(event: AgentRunEvent): CodexResult | null {
  if (event.type === 'turn.failed') {
    const text = pickString(event.error) || pickString(event) || 'Codex turn failed';
    return { text, isError: true };
  }

  if (event.type === 'item.completed') {
    const text = pickString(event.item);
    if (text) return { text, isError: false };
  }

  if (event.type === 'turn.completed') {
    const text = pickString(event);
    if (text) return { text, isError: false };
  }

  return null;
}

export function spawnCodexExec(opts: AgentRunOptions): AgentRunHandle {
  const prompt = buildPrompt(opts.systemPrompt, opts.initialMessage);
  const codexArgs = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '--cd', opts.cwd,
  ];
  const model = normalizeCodexModel(opts.model);
  const reasoningEffort = normalizeCodexReasoningEffort(opts.reasoningEffort);
  if (model) {
    codexArgs.push('--model', model);
  }
  if (reasoningEffort) {
    codexArgs.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
  }
  if (opts.fast) {
    codexArgs.push('-c', `service_tier="fast"`);
    codexArgs.push('-c', `features.fast_mode=true`);
  }
  codexArgs.push(prompt);

  const runAsUser = opts.runAsUser;
  const useRunuser = runAsUser && process.getuid?.() === 0;
  const cmd = useRunuser ? 'runuser' : 'codex';
  const args = useRunuser
    ? ['-u', runAsUser, '--', 'codex', ...codexArgs]
    : codexArgs;

  log.info('spawning', {
    runtime: 'codex',
    cwd: opts.cwd,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(opts.fast ? { fast: true } : {}),
  });

  const proc = spawn(cmd, args, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      SHELL: '/bin/bash',
      ...(useRunuser ? { HOME: `/home/${runAsUser}` } : {}),
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      ...opts.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const eventHandlers: Array<(event: AgentRunEvent) => void> = [];
  const resultHandlers: Array<(result: string, isError: boolean) => void> = [];
  const exitHandlers: Array<(code: number) => void> = [];
  let rl: ReadlineInterface | null = null;

  if (proc.stdout) {
    rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line.trim()) as AgentRunEvent;
        for (const handler of eventHandlers) handler(event);

        const result = extractResult(event);
        if (result) {
          for (const handler of resultHandlers) handler(result.text, result.isError);
        }
      } catch {
        // Skip non-JSON progress lines.
      }
    });
  }

  if (proc.stderr) {
    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) log.warn('stderr', { text: text.slice(0, 500) });
    });
  }

  proc.on('error', (err) => {
    log.error('spawn error', { error: err.message });
    for (const handler of exitHandlers) handler(1);
  });

  proc.on('close', (code) => {
    rl?.close();
    const exitCode = code ?? 1;
    log.info('exited', { code: exitCode });
    for (const handler of exitHandlers) handler(exitCode);
  });

  return {
    proc,
    sendMessage(): void {
      // codex exec is single-shot; steer is handled by kill + respawn at AgentProcess level.
    },
    kill(): void {
      if (!proc.killed) {
        log.info('killing process');
        proc.kill('SIGTERM');
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
}

export class CodexAdapter implements AgentAdapter {
  readonly runtime = 'codex' as const;

  startRun(opts: AgentRunOptions): AgentRunHandle {
    return spawnCodexExec(opts);
  }
}
