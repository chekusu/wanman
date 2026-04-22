import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDefinition } from '@wanman/core';
import {
  createAgentAdapter,
  normalizeAgentRuntime,
  resolveModel,
  resolveAgentRuntime,
} from '../agent-adapter.js';

function makeDefinition(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: 'ceo',
    lifecycle: '24/7',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'Lead the team.',
    ...overrides,
  };
}

afterEach(() => {
  delete process.env['WANMAN_RUNTIME'];
  delete process.env['WANMAN_MODEL'];
  delete process.env['WANMAN_HIGH_MODEL'];
  delete process.env['WANMAN_STANDARD_MODEL'];
  delete process.env['WANMAN_CLAUDE_MODEL'];
  delete process.env['WANMAN_CLAUDE_HIGH_MODEL'];
  delete process.env['WANMAN_CLAUDE_STANDARD_MODEL'];
  delete process.env['WANMAN_CODEX_MODEL'];
  delete process.env['WANMAN_CODEX_HIGH_MODEL'];
  delete process.env['WANMAN_CODEX_STANDARD_MODEL'];
});

describe('agent-adapter', () => {
  it('defaults to claude runtime', () => {
    expect(resolveAgentRuntime(makeDefinition())).toBe('claude');
  });

  it('uses explicit agent runtime when env override is absent', () => {
    expect(resolveAgentRuntime(makeDefinition({ runtime: 'codex' }))).toBe('codex');
  });

  it('lets WANMAN_RUNTIME override agent config', () => {
    process.env['WANMAN_RUNTIME'] = 'codex';
    expect(resolveAgentRuntime(makeDefinition({ runtime: 'claude' }))).toBe('codex');
  });

  it('normalizes unknown runtimes back to claude', () => {
    expect(normalizeAgentRuntime('gemini')).toBe('claude');
  });

  it('creates a codex adapter', () => {
    expect(createAgentAdapter('codex').runtime).toBe('codex');
  });

  it('creates a claude adapter', () => {
    expect(createAgentAdapter('claude').runtime).toBe('claude');
  });

  it('resolves abstract tiers to claude defaults', () => {
    expect(resolveModel('high', 'claude')).toBe('opus');
    expect(resolveModel('standard', 'claude')).toBe('sonnet');
  });

  it('resolves abstract tiers to codex defaults', () => {
    expect(resolveModel('high', 'codex')).toBe('gpt-5.4');
    expect(resolveModel('standard', 'codex')).toBe('gpt-5.4');
  });

  it('maps known claude aliases to runtime tiers', () => {
    expect(resolveModel('claude-opus-4-6', 'codex')).toBe('gpt-5.4');
    expect(resolveModel('haiku', 'codex')).toBe('gpt-5.4');
    expect(resolveModel('haiku', 'claude')).toBe('haiku');
  });

  it('passes through unknown provider-specific model names', () => {
    expect(resolveModel('openrouter/custom-model', 'claude')).toBe('openrouter/custom-model');
    expect(resolveModel('o4-mini', 'codex')).toBe('o4-mini');
  });

  it('allows provider-specific tier defaults from env', () => {
    process.env['WANMAN_CLAUDE_HIGH_MODEL'] = 'claude-custom-high';
    process.env['WANMAN_CODEX_STANDARD_MODEL'] = 'gpt-custom-standard';

    expect(resolveModel('high', 'claude')).toBe('claude-custom-high');
    expect(resolveModel('standard', 'codex')).toBe('gpt-custom-standard');
  });

  it('uses generic tier and provider overrides before fallback defaults', () => {
    process.env['WANMAN_HIGH_MODEL'] = 'generic-high';
    process.env['WANMAN_CLAUDE_MODEL'] = 'claude-all';
    process.env['WANMAN_CODEX_MODEL'] = 'codex-all';

    expect(resolveModel('high', 'claude')).toBe('generic-high');
    expect(resolveModel('standard', 'claude')).toBe('claude-all');
    expect(resolveModel('standard', 'codex')).toBe('codex-all');
  });
});
