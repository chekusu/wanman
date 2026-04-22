import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logger, spawnMock } = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../logger.js', () => ({
  createLogger: () => logger,
}));

import { spawnCodexExec } from '../codex-adapter.js';

type MockProc = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

function createMockProc(): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  return proc;
}

async function flushEvents(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

describe('spawnCodexExec', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env['WANMAN_RUNTIME'];
  });

  it('spawns codex exec with required flags', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    spawnCodexExec({
      runtime: 'codex',
      model: 'gpt-5.4',
      systemPrompt: 'System prompt',
      cwd: '/tmp/work',
      initialMessage: 'Do the task',
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining([
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '--cd',
        '/tmp/work',
        '--model',
        'gpt-5.4',
      ]),
      expect.objectContaining({ cwd: '/tmp/work' }),
    );

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args.at(-1)).toContain('<System>');
    expect(args.at(-1)).toContain('Do the task');
  });

  it('passes reasoning effort through codex config override', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    spawnCodexExec({
      runtime: 'codex',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      systemPrompt: 'System prompt',
      cwd: '/tmp/work',
      initialMessage: 'Do the task',
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining([
        '-c',
        'model_reasoning_effort="high"',
      ]),
      expect.objectContaining({ cwd: '/tmp/work' }),
    );
  });

  it('passes fast mode through as service_tier and fast_mode config overrides', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    spawnCodexExec({
      runtime: 'codex',
      model: 'gpt-5.4',
      fast: true,
      systemPrompt: 'System prompt',
      cwd: '/tmp/work',
      initialMessage: 'Do the task',
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain('service_tier="fast"');
    expect(args).toContain('features.fast_mode=true');
  });

  it('omits fast mode flags when fast is false or undefined', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    spawnCodexExec({
      runtime: 'codex',
      model: 'gpt-5.4',
      systemPrompt: 'System prompt',
      cwd: '/tmp/work',
      initialMessage: 'Do the task',
    });

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args.some((v) => v.includes('service_tier'))).toBe(false);
    expect(args.some((v) => v.includes('fast_mode'))).toBe(false);
  });

  it('does not pass through non-codex model identifiers', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    spawnCodexExec({
      runtime: 'codex',
      model: 'claude-opus-4-6',
      systemPrompt: 'System prompt',
      cwd: '/tmp/work',
      initialMessage: 'Do the task',
    });

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args.includes('--model')).toBe(false);
  });

  it('parses item.completed events and emits a result', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    const handle = spawnCodexExec({
      runtime: 'codex',
      model: 'gpt-5.4',
      systemPrompt: 'System prompt',
      cwd: '/tmp/work',
      initialMessage: 'Do the task',
    });

    const events: Array<Record<string, unknown>> = [];
    const results: Array<{ text: string; isError: boolean }> = [];
    handle.onEvent(event => events.push(event));
    handle.onResult((text, isError) => results.push({ text, isError }));

    proc.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: { output_text: 'Task finished' },
    })}\n`);
    await flushEvents();

    expect(events).toHaveLength(1);
    expect(results).toEqual([{ text: 'Task finished', isError: false }]);
  });

  it('parses failed turns as error results', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    const handle = spawnCodexExec({
      runtime: 'codex',
      model: 'gpt-5.4',
      systemPrompt: 'System prompt',
      cwd: '/tmp/work',
      initialMessage: 'Do the task',
    });

    const results: Array<{ text: string; isError: boolean }> = [];
    handle.onResult((text, isError) => results.push({ text, isError }));

    proc.stdout.write(`${JSON.stringify({
      type: 'turn.failed',
      error: { message: 'network timeout' },
    })}\n`);
    await flushEvents();

    expect(results).toEqual([{ text: 'network timeout', isError: true }]);
  });

  it('wait resolves with the close exit code', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    const handle = spawnCodexExec({
      runtime: 'codex',
      model: 'gpt-5.4',
      systemPrompt: 'System prompt',
      cwd: '/tmp/work',
      initialMessage: 'Do the task',
    });

    const waitPromise = handle.wait();
    proc.exitCode = 17;
    proc.emit('close', 17);

    await expect(waitPromise).resolves.toBe(17);
  });
});
