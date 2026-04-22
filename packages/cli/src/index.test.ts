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
vi.mock('./commands/task.js', () => ({ taskCommand: vi.fn() }));
vi.mock('./commands/initiative.js', () => ({ initiativeCommand: vi.fn() }));
vi.mock('./commands/capsule.js', () => ({ capsuleCommand: vi.fn() }));
vi.mock('./commands/artifact.js', () => ({ artifactCommand: vi.fn() }));
vi.mock('./commands/hypothesis.js', () => ({ hypothesisCommand: vi.fn() }));

import { run, HELP, isDirectCliExecution } from './index.js';
import { sendCommand } from './commands/send.js';
import { recvCommand } from './commands/recv.js';
import { agentsCommand } from './commands/agents.js';
import { contextCommand } from './commands/context.js';
import { escalateCommand } from './commands/escalate.js';
import { taskCommand } from './commands/task.js';
import { initiativeCommand } from './commands/initiative.js';
import { capsuleCommand } from './commands/capsule.js';
import { artifactCommand } from './commands/artifact.js';
import { hypothesisCommand } from './commands/hypothesis.js';

const mockSend = vi.mocked(sendCommand);
const mockRecv = vi.mocked(recvCommand);
const mockAgents = vi.mocked(agentsCommand);
const mockContext = vi.mocked(contextCommand);
const mockEscalate = vi.mocked(escalateCommand);
const mockTask = vi.mocked(taskCommand);
const mockInitiative = vi.mocked(initiativeCommand);
const mockCapsule = vi.mocked(capsuleCommand);
const mockArtifact = vi.mocked(artifactCommand);
const mockHypothesis = vi.mocked(hypothesisCommand);

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

  it('routes "task" to taskCommand', async () => {
    await run('task', ['list', '--status', 'open']);
    expect(mockTask).toHaveBeenCalledWith(['list', '--status', 'open']);
  });

  it('routes "initiative" to initiativeCommand', async () => {
    await run('initiative', ['get', 'init-1']);
    expect(mockInitiative).toHaveBeenCalledWith(['get', 'init-1']);
  });

  it('routes "capsule" to capsuleCommand', async () => {
    await run('capsule', ['mine', '--agent', 'dev']);
    expect(mockCapsule).toHaveBeenCalledWith(['mine', '--agent', 'dev']);
  });

  it('routes "artifact" to artifactCommand', async () => {
    await run('artifact', ['list', '--agent', 'cto']);
    expect(mockArtifact).toHaveBeenCalledWith(['list', '--agent', 'cto']);
  });

  it('routes "hypothesis" to hypothesisCommand', async () => {
    await run('hypothesis', ['update', 'hyp-1', '--status', 'accepted']);
    expect(mockHypothesis).toHaveBeenCalledWith(['update', 'hyp-1', '--status', 'accepted']);
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

describe('dynamic command routing', () => {
  it('routes "watch" to watchCommand via dynamic import', async () => {
    const mockWatchCommand = vi.fn()
    vi.doMock('./commands/watch.js', () => ({ watchCommand: mockWatchCommand }))

    await run('watch', ['--once'])
    expect(mockWatchCommand).toHaveBeenCalledWith(['--once'])

    vi.doUnmock('./commands/watch.js')
  })

  it('routes "skill:check" to skillCheckCommand via dynamic import', async () => {
    const mockSkillCheckCommand = vi.fn()
    vi.doMock('./commands/skill-check.js', () => ({ skillCheckCommand: mockSkillCheckCommand }))

    await run('skill:check', ['skills/foo/SKILL.md'])
    expect(mockSkillCheckCommand).toHaveBeenCalledWith(['skills/foo/SKILL.md'])

    vi.doUnmock('./commands/skill-check.js')
  })

  it('routes "takeover" to takeoverCommand via dynamic import', async () => {
    const mockTakeoverCommand = vi.fn()
    vi.doMock('./commands/takeover.js', () => ({ takeoverCommand: mockTakeoverCommand }))

    await run('takeover', ['/tmp/project', '--local'])
    expect(mockTakeoverCommand).toHaveBeenCalledWith(['/tmp/project', '--local'])

    vi.doUnmock('./commands/takeover.js')
  })
})

describe('direct execution detection', () => {
  it('returns true when argv entry matches import meta URL', () => {
    const entry = '/tmp/wanman-entry.js'

    expect(isDirectCliExecution(new URL(`file://${entry}`).href, ['node', entry])).toBe(true)
  })

  it('returns false without an argv entry', () => {
    expect(isDirectCliExecution('file:///tmp/wanman-entry.js', ['node'])).toBe(false)
  })

  it('returns false for invalid import URLs', () => {
    expect(isDirectCliExecution('not-a-url', ['node', '/tmp/wanman-entry.js'])).toBe(false)
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
