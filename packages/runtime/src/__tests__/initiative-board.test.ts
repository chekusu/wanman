import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { InitiativeBoard } from '../initiative-board.js';

describe('InitiativeBoard', () => {
  it('creates, resolves, updates, filters, and lists initiatives', async () => {
    const db = new Database(':memory:');
    const board = new InitiativeBoard(db);

    const first = await board.create({
      title: 'Launch docs',
      goal: 'Publish OSS docs',
      summary: 'Create public setup docs',
      status: 'active',
      priority: 2,
      sources: ['README.md'],
      createdBy: 'ceo',
    });
    const second = await board.create({
      title: 'Clean backlog',
      goal: 'Triage tasks',
      summary: 'Close stale work',
      status: 'paused',
      priority: 5,
      sources: [],
      createdBy: 'cto',
    });

    expect(board.resolveId(first.id)).toBe(first.id);
    expect(board.resolveId(first.id.slice(0, 8))).toBe(first.id);
    expect(board.get(first.id.slice(0, 8))?.sources).toEqual(['README.md']);
    expect(board.resolveId('missing')).toBeNull();

    const updated = await board.update(first.id.slice(0, 8), {
      title: 'Launch public docs',
      status: 'completed',
      priority: 10,
      sources: ['README.md', 'docs/setup.md'],
    });

    expect(updated.title).toBe('Launch public docs');
    expect(updated.status).toBe('completed');
    expect(updated.priority).toBe(10);
    expect(updated.sources).toEqual(['README.md', 'docs/setup.md']);
    await expect(board.update('missing', { status: 'completed' })).rejects.toThrow(/Initiative not found/);

    await expect(board.list({ status: 'completed' })).resolves.toHaveLength(1);
    expect(board.listSync().map(item => item.id)).toEqual([first.id, second.id]);
  });
});
