import { describe, expect, it, vi } from 'vitest';

vi.mock('log-update', () => ({
  default: vi.fn(),
}));

import { formatDashboard, renderDashboard } from './dashboard.js';
import logUpdate from 'log-update';

describe('dashboard formatting', () => {
  it('renders empty runtime state', () => {
    const output = formatDashboard({
      goal: 'Ship the first OSS version',
      loop: 0,
      maxLoops: 3,
      elapsed: 12_345,
      agents: [],
      tasks: [],
      logs: [],
      artifacts: [],
    });

    expect(output).toContain('wanman run');
    expect(output).toContain('Ship the first OSS version');
    expect(output).toContain('(waiting for health...)');
    expect(output).toContain('(no tasks yet)');
    expect(output).toContain('(no logs yet)');
  });

  it('renders active agents, sorted tasks, logs, and artifacts', () => {
    const output = formatDashboard({
      goal: 'Improve reliability',
      loop: 2,
      maxLoops: 5,
      elapsed: 61_000,
      brainName: 'wanman-run-test',
      agents: [
        { name: 'ceo', state: 'running', lifecycle: '24/7' },
        { name: 'dev', state: 'idle', lifecycle: 'on-demand' },
      ],
      tasks: [
        { id: 'done', title: 'Write release notes', status: 'done', priority: 3 },
        { id: 'active', title: 'Fix local supervisor startup', status: 'in_progress', assignee: 'dev', priority: 1 },
      ],
      logs: [
        JSON.stringify({ ts: '2026-01-01T00:00:00Z', scope: 'supervisor', msg: 'agent spawned', agent: 'dev' }),
        'plain log line',
      ],
      artifacts: [
        { agent: 'marketing', kind: 'brand_asset', cnt: 2 },
      ],
    });

    expect(output).toContain('Brain:');
    expect(output).toContain('ceo');
    expect(output).toContain('dev');
    expect(output.indexOf('Fix local supervisor startup')).toBeLessThan(output.indexOf('Write release notes'));
    expect(output).toContain('agent spawned');
    expect(output).toContain('plain log line');
    expect(output).toContain('marketing');
    expect(output).toContain('brand_asset');
  });

  it('uses log-update when rendering', () => {
    renderDashboard({
      goal: 'Render once',
      loop: 1,
      maxLoops: 1,
      elapsed: 0,
      agents: [],
      tasks: [],
      logs: [],
      artifacts: [],
    });

    expect(logUpdate).toHaveBeenCalledWith(expect.stringContaining('Render once'));
  });
});
