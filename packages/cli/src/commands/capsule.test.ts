import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../transport.js', () => ({
  rpcCall: vi.fn(),
}));

import { capsuleCommand } from './capsule.js';
import { rpcCall } from '../transport.js';

const mockRpcCall = vi.mocked(rpcCall);

describe('capsuleCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
  });

  it('passes capsule create parameters through RPC', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: { id: 'capsule-1', branch: 'wanman/fix-webhook', status: 'open', conflicts: [] },
    });

    await capsuleCommand([
      'create',
      '--goal', 'Fix webhook ingestion',
      '--owner', 'dev',
      '--branch', 'wanman/fix-webhook',
      '--base', 'abc123',
      '--paths', 'apps/api/src/routes/webhooks.ts,apps/api/src/routes/webhooks.test.ts',
      '--acceptance', 'webhook forwards payload and tests pass',
      '--initiative', 'initiative-1',
      '--task', 'task-1',
      '--subsystem', 'api-webhooks',
      '--scope-type', 'code',
    ]);

    expect(mockRpcCall).toHaveBeenCalledWith('capsule.create', expect.objectContaining({
      goal: 'Fix webhook ingestion',
      ownerAgent: 'dev',
      branch: 'wanman/fix-webhook',
      baseCommit: 'abc123',
      allowedPaths: [
        'apps/api/src/routes/webhooks.ts',
        'apps/api/src/routes/webhooks.test.ts',
      ],
      initiativeId: 'initiative-1',
      taskId: 'task-1',
      subsystem: 'api-webhooks',
      scopeType: 'code',
    }));
  });

  it('uses the current agent for capsule mine by default', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: {
        capsules: [
          { id: 'capsule-1', goal: 'Fix webhook ingestion', status: 'open', branch: 'wanman/fix-webhook', acceptance: 'tests pass' },
        ],
      },
    });

    await capsuleCommand(['mine']);

    expect(mockRpcCall).toHaveBeenCalledWith('capsule.mine', expect.objectContaining({
      agent: process.env['WANMAN_AGENT_NAME'] || 'cli',
      status: undefined,
    }));
  });

  it('lists capsules with filters and reference summaries', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: {
        capsules: [
          {
            id: 'capsule-123456789',
            goal: 'Fix webhook ingestion',
            status: 'open',
            ownerAgent: 'dev',
            branch: 'wanman/fix-webhook',
            initiativeId: 'initiative-123456',
            taskId: 'task-123456',
          },
        ],
      },
    });

    await capsuleCommand([
      'list',
      '--status', 'open',
      '--owner', 'dev',
      '--initiative', 'initiative-123456',
      '--reviewer', 'cto',
    ]);

    expect(mockRpcCall).toHaveBeenCalledWith('capsule.list', {
      status: 'open',
      ownerAgent: 'dev',
      initiativeId: 'initiative-123456',
      reviewer: 'cto',
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[open] capsule- dev wanman/fix-webhook'));
    expect(console.log).toHaveBeenCalledWith('\n1 capsule(s)');
  });

  it('prints empty messages for list and mine', async () => {
    mockRpcCall
      .mockResolvedValueOnce({ jsonrpc: '2.0', id: 1, result: { capsules: [] } })
      .mockResolvedValueOnce({ jsonrpc: '2.0', id: 1, result: { capsules: [] } });

    await capsuleCommand(['list']);
    await capsuleCommand(['mine']);

    expect(console.log).toHaveBeenCalledWith('No capsules found.');
    expect(console.log).toHaveBeenCalledWith('No owned capsules found.');
  });

  it('gets a capsule by id', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: { id: 'capsule-1', goal: 'Fix webhook ingestion' },
    });

    await capsuleCommand(['get', 'capsule-1']);

    expect(mockRpcCall).toHaveBeenCalledWith('capsule.get', { id: 'capsule-1' });
    expect(console.log).toHaveBeenCalledWith(JSON.stringify({ id: 'capsule-1', goal: 'Fix webhook ingestion' }, null, 2));
  });

  it('updates capsule metadata and parsed csv fields', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: { id: 'capsule-1', status: 'in_review' },
    });

    await capsuleCommand([
      'update',
      'capsule-1',
      '--status', 'in_review',
      '--paths', 'src/a.ts, src/b.ts',
      '--blocked-by', 'capsule-0,capsule-x',
      '--supersedes', 'capsule-old',
    ]);

    expect(mockRpcCall).toHaveBeenCalledWith('capsule.update', expect.objectContaining({
      id: 'capsule-1',
      status: 'in_review',
      allowedPaths: ['src/a.ts', 'src/b.ts'],
      blockedBy: ['capsule-0', 'capsule-x'],
      supersedes: 'capsule-old',
    }));
    expect(console.log).toHaveBeenCalledWith('Capsule capsule-1 updated [in_review]');
  });

  it('exits when required create fields are missing', async () => {
    await expect(capsuleCommand(['create', '--goal', 'Fix webhook ingestion'])).rejects.toThrow('process.exit');

    expect(mockRpcCall).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('exits on RPC errors', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'failed' },
    });

    await expect(capsuleCommand(['get', 'capsule-1'])).rejects.toThrow('process.exit');

    expect(console.error).toHaveBeenCalledWith('Error: failed');
  });
});
