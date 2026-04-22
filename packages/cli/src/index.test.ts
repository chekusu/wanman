/**
 * Tests for CLI entrypoint — command routing and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all command modules
vi.mock('./commands/send.js', () => ({ sendCommand: vi.fn() }));
vi.mock('./commands/recv.js', () => ({ recvCommand: vi.fn() }));
vi.mock('./commands/agents.js', () => ({ agentsCommand: vi.fn() }));
vi.mock('./commands/context.js', () => ({ contextCommand: vi.fn() }));
vi.mock('./commands/escalate.js', () => ({ escalateCommand: vi.fn() }));

import { run, HELP } from './index.js';
import { sendCommand } from './commands/send.js';
import { recvCommand } from './commands/recv.js';
import { agentsCommand } from './commands/agents.js';
import { contextCommand } from './commands/context.js';
import { escalateCommand } from './commands/escalate.js';

const mockSend = vi.mocked(sendCommand);
const mockRecv = vi.mocked(recvCommand);
const mockAgents = vi.mocked(agentsCommand);
const mockContext = vi.mocked(contextCommand);
const mockEscalate = vi.mocked(escalateCommand);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
});

describe('command routing', () => {
  it('routes "send" to sendCommand', async () => {
    await run('send', ['echo', 'hello']);
    expect(mockSend).toHaveBeenCalledWith(['echo', 'hello']);
  });

  it('routes "recv" to recvCommand', async () => {
    await run('recv', ['--agent', 'ceo']);
    expect(mockRecv).toHaveBeenCalledWith(['--agent', 'ceo']);
  });

  it('routes "agents" to agentsCommand', async () => {
    await run('agents', []);
    expect(mockAgents).toHaveBeenCalled();
  });

  it('routes "context" to contextCommand', async () => {
    await run('context', ['get', 'mrr']);
    expect(mockContext).toHaveBeenCalledWith(['get', 'mrr']);
  });

  it('routes "escalate" to escalateCommand', async () => {
    await run('escalate', ['urgent', 'problem']);
    expect(mockEscalate).toHaveBeenCalledWith(['urgent', 'problem']);
  });
});

describe('help output', () => {
  it('shows help for "help" command', async () => {
    await run('help', []);
    expect(console.log).toHaveBeenCalledWith(HELP);
  });

  it('shows help for "--help" flag', async () => {
    await run('--help', []);
    expect(console.log).toHaveBeenCalledWith(HELP);
  });

  it('shows help for "-h" flag', async () => {
    await run('-h', []);
    expect(console.log).toHaveBeenCalledWith(HELP);
  });

  it('shows help when no command is given', async () => {
    await run(undefined, []);
    expect(console.log).toHaveBeenCalledWith(HELP);
  });

  it('omits removed SaaS commands from HELP', () => {
    expect(HELP).not.toContain('wanman story');
    expect(HELP).not.toContain('wanman launch');
    expect(HELP).not.toContain('launch-runner');
    expect(HELP).not.toContain('WANMAN_API_URL');
    expect(HELP).not.toContain('WANMAN_API_TOKEN');
    expect(HELP).not.toContain('WANMAN_RUNNER_SECRET');
  });
});

describe('run command routing', () => {
  it('routes "run" to runCommand via dynamic import', async () => {
    const mockRunCommand = vi.fn()
    vi.doMock('./commands/run.js', () => ({ runCommand: mockRunCommand }))

    // Re-import to pick up the mock
    const { run: runFn } = await import('./index.js')
    await runFn('run', ['test goal', '--loops', '5'])
    expect(mockRunCommand).toHaveBeenCalledWith(['test goal', '--loops', '5'])

    vi.doUnmock('./commands/run.js')
  })

  it('surfaces errors thrown by the run command', async () => {
    const mockRunCommand = vi.fn().mockRejectedValue(new Error('boom'))
    vi.doMock('./commands/run.js', () => ({ runCommand: mockRunCommand }))

    const { run: runFn } = await import('./index.js')
    await expect(runFn('run', ['goal'])).rejects.toThrow('process.exit')
    expect(console.error).toHaveBeenCalledWith('boom')

    vi.doUnmock('./commands/run.js')
  })
})

describe('unknown command', () => {
  it('prints error and exits with code 1', async () => {
    await expect(run('foobar', [])).rejects.toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith('Unknown command: foobar');
    expect(console.log).toHaveBeenCalledWith(HELP);
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('error handling', () => {
  it('shows friendly message for fetch failed errors', async () => {
    mockSend.mockRejectedValue(new Error('fetch failed'));
    await expect(run('send', ['agent', 'msg'])).rejects.toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith('Cannot connect to Supervisor. Is it running?');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('URL:'));
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('shows error message for generic errors', async () => {
    mockAgents.mockRejectedValue(new Error('Something went wrong'));
    await expect(run('agents', [])).rejects.toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith('Something went wrong');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('handles non-Error throws', async () => {
    mockRecv.mockRejectedValue('string error');
    await expect(run('recv', [])).rejects.toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith('string error');
  });
});
