import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalRuntimeClient } from './runtime-client.js';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('createLocalRuntimeClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches health from the local supervisor', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(jsonResponse({ agents: [{ name: 'ceo', state: 'idle', lifecycle: '24/7' }] }));

    const health = await createLocalRuntimeClient(3120).getHealth();

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3120/health');
    expect(health.agents[0]?.name).toBe('ceo');
  });

  it('throws when health returns a non-OK response', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(jsonResponse({}, { ok: false, status: 503 }));

    await expect(createLocalRuntimeClient(3120).getHealth()).rejects.toThrow('Health failed with status 503');
  });

  it('calls task, initiative, capsule, and artifact RPC methods', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ result: { tasks: [{ id: 't1', title: 'Task', status: 'pending', priority: 1 }] } }))
      .mockResolvedValueOnce(jsonResponse({ result: { initiatives: [{ id: 'i1', title: 'Roadmap', status: 'active' }] } }))
      .mockResolvedValueOnce(jsonResponse({ result: { capsules: [{ id: 'c1', status: 'open' }] } }))
      .mockResolvedValueOnce(jsonResponse({
        result: {
          artifacts: [
            { agent: 'ceo', kind: 'note' },
            { agent: 'ceo', kind: 'note', cnt: 2 },
            { agent: 'dev', kind: 'patch' },
          ],
        },
      }));

    const client = createLocalRuntimeClient(3120);

    expect(await client.listTasks()).toEqual([{ id: 't1', title: 'Task', status: 'pending', priority: 1 }]);
    expect(await client.listInitiatives()).toEqual([{ id: 'i1', title: 'Roadmap', status: 'active' }]);
    expect(await client.listCapsules()).toEqual([{ id: 'c1', status: 'open' }]);
    expect(await client.listArtifacts()).toEqual([
      { agent: 'ceo', kind: 'note', cnt: 3 },
      { agent: 'dev', kind: 'patch', cnt: 1 },
    ]);

    const methods = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).method);
    expect(methods).toEqual(['task.list', 'initiative.list', 'capsule.list', 'artifact.list']);
  });

  it('sends mutation RPC methods', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(jsonResponse({ result: { ok: true } }));

    const client = createLocalRuntimeClient(3120);
    await client.createInitiative({ title: 'Roadmap', goal: 'Ship', summary: 'Next', priority: 8, sources: ['README.md'] });
    await client.sendMessage({ from: 'ceo', to: 'dev', payload: 'Build it' });
    await client.spawnAgent('dev', 'dev-2');
    await client.updateTask({ id: 't1', status: 'done' });

    const payloads = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(payloads.map(payload => payload.method)).toEqual([
      'initiative.create',
      'agent.send',
      'agent.spawn',
      'task.update',
    ]);
    expect(payloads[1]?.params).toEqual({ from: 'ceo', to: 'dev', payload: 'Build it' });
  });

  it('throws on RPC transport and application errors', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'bad request' } }));

    const client = createLocalRuntimeClient(3120);

    await expect(client.listTasks()).rejects.toThrow('RPC task.list failed with status 500');
    await expect(client.listTasks()).rejects.toThrow('bad request');
  });
});
