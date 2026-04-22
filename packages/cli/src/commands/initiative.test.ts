import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../transport.js', () => ({
  rpcCall: vi.fn(),
}));

import { initiativeCommand } from './initiative.js';
import { rpcCall } from '../transport.js';

const mockRpcCall = vi.mocked(rpcCall);

describe('initiativeCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
  });

  it('passes initiative create parameters through RPC', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: { id: 'initiative-1', title: 'Roadmap', status: 'active' },
    });

    await initiativeCommand([
      'create',
      'Advance roadmap',
      '--goal', 'Ship the next roadmap milestone',
      '--summary', 'Prioritize external value',
      '--priority', '9',
      '--source', 'README.md,docs/ROADMAP.md',
    ]);

    expect(mockRpcCall).toHaveBeenCalledWith('initiative.create', expect.objectContaining({
      title: 'Advance roadmap',
      goal: 'Ship the next roadmap milestone',
      summary: 'Prioritize external value',
      priority: 9,
      sources: ['README.md', 'docs/ROADMAP.md'],
    }));
  });

  it('lists initiatives', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: {
        initiatives: [
          { id: 'abc12345-1111-2222-3333-444444444444', title: 'Roadmap', status: 'active', priority: 9, summary: 'External delivery' },
        ],
      },
    });

    await initiativeCommand(['list', '--status', 'active']);

    expect(mockRpcCall).toHaveBeenCalledWith('initiative.list', { status: 'active' });
    expect(console.log).toHaveBeenCalledWith('[active] abc12345 P9 "Roadmap" — External delivery');
  });

  it('prints an empty message when no initiatives match', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: { initiatives: [] },
    });

    await initiativeCommand(['list']);

    expect(console.log).toHaveBeenCalledWith('No initiatives found.');
  });

  it('gets an initiative by id', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: { id: 'initiative-1', title: 'Roadmap', status: 'active' },
    });

    await initiativeCommand(['get', 'initiative-1']);

    expect(mockRpcCall).toHaveBeenCalledWith('initiative.get', { id: 'initiative-1' });
    expect(console.log).toHaveBeenCalledWith(JSON.stringify({ id: 'initiative-1', title: 'Roadmap', status: 'active' }, null, 2));
  });

  it('updates an initiative with optional fields', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: { id: 'initiative-1', status: 'paused' },
    });

    await initiativeCommand([
      'update',
      'initiative-1',
      '--title', 'Updated roadmap',
      '--goal', 'Ship better',
      '--summary', 'Scope adjusted',
      '--priority', '4',
      '--source', 'README.md,docs/roadmap.md',
      '--status', 'paused',
    ]);

    expect(mockRpcCall).toHaveBeenCalledWith('initiative.update', expect.objectContaining({
      id: 'initiative-1',
      title: 'Updated roadmap',
      goal: 'Ship better',
      summary: 'Scope adjusted',
      priority: 4,
      sources: ['README.md', 'docs/roadmap.md'],
      status: 'paused',
    }));
    expect(console.log).toHaveBeenCalledWith('Initiative initiative-1 updated [paused]');
  });

  it('exits when required create fields are missing', async () => {
    await expect(initiativeCommand(['create', 'Untargeted'])).rejects.toThrow('process.exit');

    expect(mockRpcCall).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('exits on RPC errors', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'failed' },
    });

    await expect(initiativeCommand(['get', 'initiative-1'])).rejects.toThrow('process.exit');

    expect(console.error).toHaveBeenCalledWith('Error: failed');
  });
});
