import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalSupervisorHandle } from './local-supervisor.js';

const startLocalSupervisorMock = vi.hoisted(() => vi.fn());

vi.mock('./local-supervisor.js', () => ({
  startLocalSupervisor: startLocalSupervisorMock,
}));

import { runLocalSupervisorSession } from './local-supervisor-session.js';

function makeSupervisor(overrides: Partial<LocalSupervisorHandle> = {}): LocalSupervisorHandle {
  const child = new EventEmitter() as LocalSupervisorHandle['child'] & { exitCode: number | null };
  child.kill = vi.fn() as LocalSupervisorHandle['child']['kill'];
  child.exitCode = null;

  return {
    runtime: {
      waitForHealth: vi.fn().mockResolvedValue(undefined),
      getHealth: vi.fn(),
      listTasks: vi.fn(),
      listInitiatives: vi.fn(),
      listCapsules: vi.fn(),
      listArtifacts: vi.fn(),
      createInitiative: vi.fn(),
      sendMessage: vi.fn(),
      spawnAgent: vi.fn(),
      updateTask: vi.fn(),
    },
    endpoint: 'http://127.0.0.1:3120',
    entrypoint: '/tmp/entrypoint.js',
    port: 3120,
    child,
    readLogs: vi.fn().mockResolvedValue({ lines: [], cursor: 0 }),
    attachSignalForwarding: vi.fn(() => vi.fn()),
    stop: vi.fn().mockResolvedValue(undefined),
    waitForExit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const supervisorOptions = {
  configPath: '/tmp/agents.json',
  workspaceRoot: '/tmp/agents',
  gitRoot: '/tmp/repo',
  sharedSkillsDir: '/tmp/skills',
  homeRoot: '/tmp/home',
};

describe('runLocalSupervisorSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the session after the supervisor becomes healthy and disposes it', async () => {
    const supervisor = makeSupervisor();
    startLocalSupervisorMock.mockResolvedValue(supervisor);
    const onStarted = vi.fn();
    const onHealthy = vi.fn();
    const onStopped = vi.fn();
    const run = vi.fn().mockResolvedValue(undefined);

    await runLocalSupervisorSession({
      supervisor: supervisorOptions,
      onStarted,
      onHealthy,
      onStopped,
      run,
    });

    expect(startLocalSupervisorMock).toHaveBeenCalledWith(supervisorOptions);
    expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ endpoint: supervisor.endpoint }));
    expect(onHealthy).toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ runtime: supervisor.runtime }));
    expect(supervisor.stop).toHaveBeenCalled();
    expect(supervisor.waitForExit).toHaveBeenCalled();
    expect(onStopped).toHaveBeenCalledWith(expect.any(Object), 'completed');
  });

  it('surfaces early supervisor exits with log tail context', async () => {
    const supervisor = makeSupervisor({
      runtime: {
        ...makeSupervisor().runtime,
        waitForHealth: vi.fn(() => new Promise<void>(() => undefined)),
      },
      readLogs: vi.fn().mockResolvedValue({ lines: ['first log', 'last log'], cursor: 2 }),
    });
    startLocalSupervisorMock.mockResolvedValue(supervisor);
    const onError = vi.fn();

    await runLocalSupervisorSession({
      supervisor: supervisorOptions,
      onStarted: () => {
        setTimeout(() => supervisor.child.emit('close', 2), 0);
      },
      onError,
      run: vi.fn(),
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Supervisor exited before becoming healthy with code 2'),
      }),
      expect.any(Object),
    );
    expect(String(onError.mock.calls[0]?.[0].message)).toContain('last log');
    expect(supervisor.stop).toHaveBeenCalled();
  });

  it('keeps the supervisor alive when requested', async () => {
    const supervisor = makeSupervisor();
    startLocalSupervisorMock.mockResolvedValue(supervisor);
    const onKeptAlive = vi.fn();

    await runLocalSupervisorSession({
      supervisor: supervisorOptions,
      keep: true,
      onKeptAlive,
      run: vi.fn().mockResolvedValue(undefined),
    });

    expect(supervisor.stop).not.toHaveBeenCalled();
    expect(supervisor.waitForExit).not.toHaveBeenCalled();
    expect(onKeptAlive).toHaveBeenCalledWith(expect.any(Object), 'completed');
  });
});
