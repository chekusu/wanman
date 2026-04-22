import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../transport.js', () => ({
  rpcCall: vi.fn(),
}));

import { hypothesisCommand } from './hypothesis.js';
import { rpcCall } from '../transport.js';

const mockRpcCall = vi.mocked(rpcCall);

describe('hypothesisCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
  });

  it('creates a hypothesis with optional planning fields', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: [{ id: 12 }],
    });

    await hypothesisCommand([
      'create',
      'Deepen location analysis',
      '--rationale', 'Risk is underexplored',
      '--expected-value', 'Reduce launch risk',
      '--estimated-cost', '2 tasks',
      '--parent', '5',
    ]);

    expect(mockRpcCall).toHaveBeenCalledWith('hypothesis.create', {
      title: 'Deepen location analysis',
      agent: process.env['WANMAN_AGENT_NAME'] || 'ceo',
      rationale: 'Risk is underexplored',
      expectedValue: 'Reduce launch risk',
      estimatedCost: '2 tasks',
      parentId: 5,
    });
    expect(console.log).toHaveBeenCalledWith('Hypothesis #12 created: Deepen location analysis');
  });

  it('requires a title when creating a hypothesis', async () => {
    await expect(hypothesisCommand(['create', '--rationale', 'missing title'])).rejects.toThrow('process.exit');

    expect(mockRpcCall).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('Error: title is required');
  });

  it('lists hypotheses with filters and tree context', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: [
        {
          id: 7,
          parent_id: 3,
          title: 'Improve retention',
          status: 'validated',
          rationale: 'Cohort data',
          outcome: 'Activation improved after onboarding cleanup',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    });

    await hypothesisCommand(['list', '--status', 'validated', '--tree', '3']);

    expect(mockRpcCall).toHaveBeenCalledWith('hypothesis.list', {
      status: 'validated',
      treeRoot: 3,
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('#7 validated'));
    expect(console.log).toHaveBeenCalledWith('\n1 hypothesis(es)');
  });

  it('prints a helpful message when no hypotheses match', async () => {
    mockRpcCall.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: [] });

    await hypothesisCommand(['list']);

    expect(console.log).toHaveBeenCalledWith('No hypotheses found.');
  });

  it('updates status, outcome, and evidence ids', async () => {
    mockRpcCall.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { id: 9 } });

    await hypothesisCommand([
      'update',
      '9',
      '--status', 'validated',
      '--outcome', 'Evidence supported the path',
      '--evidence', '42, 43',
    ]);

    expect(mockRpcCall).toHaveBeenCalledWith('hypothesis.update', {
      id: 9,
      status: 'validated',
      outcome: 'Evidence supported the path',
      evidence: [42, 43],
    });
    expect(console.log).toHaveBeenCalledWith('Hypothesis #9 updated: status=validated');
  });

  it('requires status when updating', async () => {
    await expect(hypothesisCommand(['update', '9'])).rejects.toThrow('process.exit');

    expect(mockRpcCall).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('Error: --status is required');
  });
});
