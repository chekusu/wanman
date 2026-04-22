import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../transport.js', () => ({
  rpcCall: vi.fn(),
}));

import { artifactCommand } from './artifact.js';
import { rpcCall } from '../transport.js';

const mockRpcCall = vi.mocked(rpcCall);

describe('artifactCommand', () => {
  const tmpDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'wanman-artifact-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('stores an artifact with inline content and metadata', async () => {
    mockRpcCall.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { id: 42 } });

    await artifactCommand([
      'put',
      '--kind', 'brand_asset',
      '--path', 'brand/identity/handbook',
      '--source', 'marketing',
      '--confidence', '0.9',
      '--content', 'brand content',
      '{"name":"Brand Handbook"}',
    ]);

    expect(mockRpcCall).toHaveBeenCalledWith('artifact.put', expect.objectContaining({
      kind: 'brand_asset',
      agent: process.env['WANMAN_AGENT_NAME'] || 'cli',
      source: 'marketing',
      confidence: 0.9,
      path: 'brand/identity/handbook',
      content: 'brand content',
      metadata: { name: 'Brand Handbook' },
    }));
    expect(console.log).toHaveBeenCalledWith('Artifact stored: kind=brand_asset source=marketing confidence=0.9');
  });

  it('reads artifact content from --file before falling back to inline content', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'artifact.md');
    fs.writeFileSync(file, 'file content');
    mockRpcCall.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { id: 42 } });

    await artifactCommand([
      'put',
      '--kind', 'brand_asset',
      '--path', 'brand/identity/handbook',
      '--source', 'marketing',
      '--confidence', '0.9',
      '--file', file,
      '--content', 'inline content',
      '{"name":"Brand Handbook"}',
    ]);

    expect(mockRpcCall).toHaveBeenCalledWith('artifact.put', expect.objectContaining({
      content: 'file content',
    }));
  });

  it('fails when --file cannot be read', async () => {
    await expect(artifactCommand([
      'put',
      '--kind', 'brand_asset',
      '--path', 'brand/identity/handbook',
      '--source', 'marketing',
      '--confidence', '0.9',
      '--file', '/tmp/does-not-exist-wanman-artifact',
      '{"name":"Brand Handbook"}',
    ])).rejects.toThrow('process.exit');

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('cannot read file'));
  });

  it('validates required put flags, metadata presence, and metadata JSON', async () => {
    await expect(artifactCommand([
      'put',
      '--kind', 'brand_asset',
      '--path', 'brand/identity/handbook',
      '{"name":"Brand Handbook"}',
    ])).rejects.toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith('Error: --kind, --path, --source, and --confidence are required');

    await expect(artifactCommand([
      'put',
      '--kind', 'brand_asset',
      '--path', 'brand/identity/handbook',
      '--source', 'marketing',
      '--confidence', '0.9',
    ])).rejects.toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith('Error: metadata JSON is required as the last argument');

    await expect(artifactCommand([
      'put',
      '--kind', 'brand_asset',
      '--path', 'brand/identity/handbook',
      '--source', 'marketing',
      '--confidence', '0.9',
      '{bad-json}',
    ])).rejects.toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith('Error: invalid metadata JSON');
  });

  it('warns on shallow artifact paths but still stores the artifact', async () => {
    mockRpcCall.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { id: 42 } });

    await artifactCommand([
      'put',
      '--kind', 'brand_asset',
      '--path', 'handbook',
      '--source', 'marketing',
      '--confidence', '0.9',
      '{"name":"Brand Handbook"}',
    ]);

    expect(console.error).toHaveBeenCalledWith('Warning: --path should use format "{domain}/{category}/{item}", got "handbook"');
    expect(mockRpcCall).toHaveBeenCalled();
  });

  it('exits when artifact put returns an RPC error', async () => {
    mockRpcCall.mockResolvedValue({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'store failed' } });

    await expect(artifactCommand([
      'put',
      '--kind', 'brand_asset',
      '--path', 'brand/identity/handbook',
      '--source', 'marketing',
      '--confidence', '0.9',
      '{"name":"Brand Handbook"}',
    ])).rejects.toThrow('process.exit');

    expect(console.error).toHaveBeenCalledWith('Error: store failed');
  });

  it('flags allowed non-standard artifact kinds in metadata', async () => {
    mockRpcCall.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { id: 43 } });

    await artifactCommand([
      'put',
      '--kind', 'experiment_note',
      '--path', 'research/notes/n1',
      '--source', 'feedback',
      '--confidence', '0.4',
      '--allow-nonstandard',
      '{"title":"note"}',
    ]);

    expect(mockRpcCall).toHaveBeenCalledWith('artifact.put', expect.objectContaining({
      kind: 'experiment_note',
      metadata: { title: 'note', non_standard_kind: true },
    }));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Warning: non-standard kind'));
  });

  it('blocks non-standard artifact kinds unless explicitly allowed', async () => {
    await expect(artifactCommand([
      'put',
      '--kind', 'experiment_note',
      '--path', 'research/notes/n1',
      '--source', 'feedback',
      '--confidence', '0.4',
      '{"title":"note"}',
    ])).rejects.toThrow('process.exit');

    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it('validates confidence', async () => {
    await expect(artifactCommand([
      'put',
      '--kind', 'brand_asset',
      '--path', 'brand/identity/handbook',
      '--source', 'marketing',
      '--confidence', '2',
      '{"name":"Brand Handbook"}',
    ])).rejects.toThrow('process.exit');

    expect(console.error).toHaveBeenCalledWith('Error: --confidence must be a number between 0 and 1');
  });

  it('lists artifacts with filters', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: [
        {
          id: 7,
          agent: 'marketing',
          kind: 'brand_asset',
          path: 'brand/identity/handbook',
          content_length: 1536,
          metadata: { source: 'docs', confidence: 0.8, verified: true },
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    });

    await artifactCommand(['list', '--agent', 'marketing', '--kind', 'brand_asset', '--unverified']);

    expect(mockRpcCall).toHaveBeenCalledWith('artifact.list', {
      agent: 'marketing',
      kind: 'brand_asset',
      verified: false,
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('#7 brand_asset'));
    expect(console.log).toHaveBeenCalledWith('\n1 artifact(s)');
  });

  it('prints a helpful message when no artifacts match', async () => {
    mockRpcCall.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: [] });

    await artifactCommand(['list']);

    expect(console.log).toHaveBeenCalledWith('No artifacts found.');
  });

  it('exits when artifact list returns an RPC error', async () => {
    mockRpcCall.mockResolvedValue({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'list failed' } });

    await expect(artifactCommand(['list'])).rejects.toThrow('process.exit');

    expect(console.error).toHaveBeenCalledWith('Error: list failed');
  });

  it('gets an artifact with stored content', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: [
        {
          id: 7,
          agent: 'marketing',
          kind: 'brand_asset',
          path: 'brand/identity/handbook',
          content: 'brand content',
          metadata: { source: 'docs' },
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    });

    await artifactCommand(['get', '7']);

    expect(mockRpcCall).toHaveBeenCalledWith('artifact.get', { id: 7 });
    expect(console.log).toHaveBeenCalledWith('# Artifact #7');
    expect(console.log).toHaveBeenCalledWith('brand content');
  });

  it('prints a no-content marker for artifacts without content', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: [
        {
          id: 7,
          agent: 'marketing',
          kind: 'brand_asset',
          path: '',
          content: null,
          metadata: { source: 'docs' },
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    });

    await artifactCommand(['get', '7']);

    expect(console.log).toHaveBeenCalledWith('path: (none)');
    expect(console.log).toHaveBeenCalledWith('\n(no content stored)');
  });

  it('validates artifact get arguments and missing artifacts', async () => {
    await expect(artifactCommand(['get'])).rejects.toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith('Error: artifact id is required');

    mockRpcCall.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: [] });
    await expect(artifactCommand(['get', '404'])).rejects.toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith('Artifact #404 not found');
  });

  it('exits when artifact get returns an RPC error or the command is unknown', async () => {
    mockRpcCall.mockResolvedValue({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'get failed' } });

    await expect(artifactCommand(['get', '7'])).rejects.toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith('Error: get failed');

    await expect(artifactCommand(['unknown'])).rejects.toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });
});
