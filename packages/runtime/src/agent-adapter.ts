import type { ChildProcess } from 'child_process';
import type { AgentDefinition, AgentRuntime, ModelTier } from '@wanman/core';
import { ClaudeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';

export interface AgentRunEvent extends Record<string, unknown> {
  type: string;
}

export interface AgentRunHandle {
  proc: ChildProcess;
  sendMessage(content: string, sessionId?: string): void;
  kill(): void;
  wait(): Promise<number>;
  onEvent(handler: (event: AgentRunEvent) => void): void;
  onResult(handler: (result: string, isError: boolean) => void): void;
  onExit(handler: (code: number) => void): void;
}

export interface AgentRunOptions {
  runtime: AgentRuntime;
  model: ModelTier;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * Codex-only: enable fast mode (`/fast on`).
   * Adds `-c service_tier="fast"` and `-c features.fast_mode=true`,
   * which ~1.5x throughput at ~2x credit cost.
   * Ignored when runtime !== 'codex'.
   */
  fast?: boolean;
  systemPrompt: string;
  cwd: string;
  initialMessage?: string;
  sessionId?: string;
  env?: Record<string, string>;
  runAsUser?: string;
}

export interface AgentAdapter {
  readonly runtime: AgentRuntime;
  startRun(opts: AgentRunOptions): AgentRunHandle;
}

export function normalizeAgentRuntime(value?: string | null): AgentRuntime {
  return value === 'codex' ? 'codex' : 'claude';
}

/**
 * Resolve a model identifier for the target runtime.
 *
 * Claude Code CLI understands short names ('haiku', 'sonnet') natively, so
 * for claude runtime we pass through as-is. For non-claude runtimes, we map
 * Claude model names to equivalent tiers.
 */
const CLAUDE_MODEL_TIER: Record<string, 'high' | 'standard'> = {
  'opus': 'high', 'claude-opus-4-6': 'high',
  'sonnet': 'standard', 'claude-sonnet-4-6': 'standard',
  'haiku': 'standard', 'claude-haiku-4-5': 'standard',
};

const RUNTIME_MODEL_DEFAULTS: Record<string, Record<'high' | 'standard', string>> = {
  codex: { high: 'gpt-5.4', standard: 'gpt-5.4' },
};

export function resolveModel(model: string, runtime: AgentRuntime): string {
  if (runtime === 'claude') return model;
  const tier = CLAUDE_MODEL_TIER[model];
  if (!tier) return model;
  return RUNTIME_MODEL_DEFAULTS[runtime]?.[tier] ?? model;
}

export function resolveAgentRuntime(definition: AgentDefinition): AgentRuntime {
  return normalizeAgentRuntime(process.env['WANMAN_RUNTIME'] ?? definition.runtime);
}

export function createAgentAdapter(runtime: AgentRuntime): AgentAdapter {
  if (runtime === 'codex') {
    return new CodexAdapter();
  }
  return new ClaudeAdapter();
}
