/**
 * Single agent lifecycle manager.
 *
 * - 24/7 agents: run in a loop, respawning when Claude Code exits
 * - on-demand agents: spawned when a message arrives, exit when done
 * - idle_cached agents: like on-demand, but the runtime persists the
 *   session id across triggers so the next spawn resumes prior context
 *   via `claude --resume`. Combines "no CPU when idle" with "preserved
 *   conversation context" for stateful agents that should not run forever.
 * - steer: when a steer message arrives, kill the current process and
 *   respawn with the steer message prepended (safest approach per design doc)
 */

import type { AgentDefinition, AgentState } from '@wanman/core';
import {
  type AgentRunEvent,
  createAgentAdapter,
  resolveAgentRuntime,
  resolveModel,
  type AgentRunHandle,
} from './agent-adapter.js';
import { type CredentialManager } from './credential-manager.js';
import { createLogger } from './logger.js';
import { resolveMaybePromise, type MessageTransport } from './runtime-contracts.js';

const log = createLogger('agent-process');

/** Delay between agent loop iterations (10s) */
const LOOP_DELAY_MS = 10_000;
/** Delay before respawning after exit (5s) */
const RESPAWN_DELAY_MS = 5_000;

/** Callback to generate a context preamble for agent respawns */
export type PreambleProvider = (agentName: string) => string | undefined | Promise<string | undefined>;

/** Data emitted when an agent run completes (for run_feedback tracking) */
export interface RunCompleteInfo {
  agentName: string
  exitCode: number
  durationMs: number
  errored: boolean
  /** Number of steer interrupts received during this run */
  steerCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/** Callback invoked after each agent run completes */
export type RunCompleteCallback = (info: RunCompleteInfo) => void;
export type AutonomousWorkChecker = (agentName: string) => boolean;
export type EnvironmentProvider = (agentName: string) => Record<string, string> | Promise<Record<string, string>>;

interface TokenUsageSnapshot {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export function buildGoalPrompt(agentName: string, goal?: string): string | undefined {
  if (!goal) return undefined

  const taskInstruction = agentName === 'ceo'
    ? 'Run `wanman task list` to check current task progress. If no tasks exist yet, analyze the goal and create tasks.'
    : `Run \`wanman task list --assignee ${agentName}\` to check your assigned tasks. If no tasks are assigned yet, do not create new backlog on your own. Wait for CEO assignment, or send CEO a short note only if you discover a missing prerequisite or duplicate work.`

  const langInstruction = process.env['WANMAN_OUTPUT_LANG']
    ? `\n\nIMPORTANT: All your output (task titles, artifacts, reports, messages) MUST be written in the same language as the goal above.`
    : ''

  return `## Current Goal\n\nYour core objective is: ${goal}\n\n${taskInstruction}${langInstruction}`
}

function resolveCodexReasoningEffort(extraEnv: Record<string, string>, runtime: 'claude' | 'codex'): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (runtime !== 'codex') return undefined;
  const raw = extraEnv['WANMAN_CODEX_REASONING_EFFORT'] ?? process.env['WANMAN_CODEX_REASONING_EFFORT'];
  switch (raw?.trim().toLowerCase()) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return raw.trim().toLowerCase() as 'low' | 'medium' | 'high' | 'xhigh';
    default:
      return undefined;
  }
}

function resolveCodexFast(extraEnv: Record<string, string>, runtime: 'claude' | 'codex'): boolean {
  if (runtime !== 'codex') return false;
  const raw = (extraEnv['WANMAN_CODEX_FAST'] ?? process.env['WANMAN_CODEX_FAST'] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

export class AgentProcess {
  readonly definition: AgentDefinition;
  private relay: MessageTransport;
  private workDir: string;
  private credentialManager?: CredentialManager;
  private extraEnv: Record<string, string>;
  private currentProcess: AgentRunHandle | null = null;
  private _state: AgentState = 'idle';
  private abortController: AbortController | null = null;

  get state(): AgentState { return this._state; }

  /** Top-level goal for goal-driven agents (injected via config). */
  private goal?: string;
  /** Optional callback to generate context preamble on respawn */
  private preambleProvider?: PreambleProvider;
  /** Optional callback invoked after each run completes */
  private onRunComplete?: RunCompleteCallback;
  /** Count of steer interrupts in current lifecycle */
  private _steerCount = 0;
  /** Optional time budget per spawn in ms. Process is killed after this. */
  private timeBudgetMs?: number;
  /** Optional runtime-owned check to skip empty 24/7 worker spins. */
  private hasAutonomousWork?: AutonomousWorkChecker;
  /** Optional callback to build per-run environment. */
  private envProvider?: EnvironmentProvider;
  /** Latest runtime-reported token usage snapshot for the active run. */
  private currentUsage: TokenUsageSnapshot = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  /**
   * Most recent session id reported by the underlying CLI (e.g. Claude's
   * `system/init` event). For `idle_cached` agents this is passed back as
   * `resumeSessionId` on the next spawn so the agent retains conversation
   * context across idle periods. Cleared on a stale-session fallback.
   */
  private lastSessionId: string | null = null;
  /**
   * Set by `registerSessionIdCapture` when the most recent spawn passed a
   * resume id but the adapter reported the session was unavailable. Read
   * (and reset) by `trigger()` to drive the cold-start retry path.
   */
  private lastSpawnResumeMissed = false;

  constructor(
    definition: AgentDefinition,
    relay: MessageTransport,
    workDir: string,
    credentialManager?: CredentialManager,
    extraEnv?: Record<string, string>,
    goal?: string,
    preambleProvider?: PreambleProvider,
    onRunComplete?: RunCompleteCallback,
    timeBudgetMs?: number,
    hasAutonomousWork?: AutonomousWorkChecker,
    envProvider?: EnvironmentProvider,
  ) {
    // `idle_cached` is Claude-only: the resume mechanism relies on capturing
    // Claude's `system/init` session id and passing it back as `--resume <id>`.
    // Codex has no equivalent in this runtime today, so pairing `idle_cached`
    // with a non-Claude runtime would silently degrade to `on-demand`
    // semantics (no preserved context).
    //
    // Reject at construction using the *effective* runtime (i.e. honoring the
    // `WANMAN_RUNTIME` env override, not just the declared `agent.runtime`)
    // so an operator who runs `WANMAN_RUNTIME=codex wanman start` against an
    // agents.json with idle_cached agents sees the problem at startup, not
    // after wondering why context is being lost across triggers.
    if (definition.lifecycle === 'idle_cached') {
      const effectiveRuntime = resolveAgentRuntime(definition);
      if (effectiveRuntime !== 'claude') {
        const declared = definition.runtime ?? '(default)';
        const overridden = process.env['WANMAN_RUNTIME'] && process.env['WANMAN_RUNTIME'] !== definition.runtime
          ? ` (forced by WANMAN_RUNTIME=${process.env['WANMAN_RUNTIME']})`
          : '';
        throw new Error(
          `Agent "${definition.name}" has lifecycle "idle_cached" but the effective runtime is "${effectiveRuntime}"${overridden}. `
          + `idle_cached only works with the Claude runtime — it relies on \`claude --resume\` to restore conversation context across triggers, `
          + `which Codex has no equivalent for in this runtime. `
          + `Either keep the runtime as "claude" (declared: "${declared}") or change the lifecycle to "on-demand".`
        );
      }
    }

    this.definition = definition;
    this.relay = relay;
    this.workDir = workDir;
    this.credentialManager = credentialManager;
    this.extraEnv = extraEnv ?? {};
    this.goal = goal;
    this.preambleProvider = preambleProvider;
    this.onRunComplete = onRunComplete;
    this.timeBudgetMs = timeBudgetMs;
    this.hasAutonomousWork = hasAutonomousWork;
    this.envProvider = envProvider;
  }

  /**
   * Start the agent. Behaviour depends on the configured lifecycle:
   * - `24/7`: enter a respawn loop. Each loop iteration spawns a fresh CLI
   *   subprocess (with the agent's system prompt + a fresh session by
   *   default).
   * - `on-demand`: stay idle. Triggered explicitly by `trigger()` or
   *   `handleSteer()`; each run is stateless.
   * - `idle_cached`: stay idle like `on-demand`. Differs only in that
   *   `lastSessionId` is preserved across triggers, so the next run resumes
   *   the prior Claude session via `--resume`.
   */
  async start(): Promise<void> {
    if (this.definition.lifecycle === '24/7') {
      this.runLoop();
    } else {
      // on-demand / idle_cached: stay idle, will be triggered by handleSteer or trigger()
      this._state = 'idle';
      log.info('idle agent ready', {
        agent: this.definition.name,
        lifecycle: this.definition.lifecycle,
      });
    }
  }

  private setIdleIfActive(): void {
    if (this._state !== 'stopped') {
      this._state = 'idle';
    }
  }

  private isStopped(): boolean {
    return this._state === 'stopped';
  }

  /** Run loop for 24/7 agents — spawn, wait for exit, respawn. */
  private async runLoop(): Promise<void> {
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    while (!signal.aborted) {
      try {
        // Wait while paused — don't respawn
        if (this._state === 'paused') {
          await sleep(LOOP_DELAY_MS, signal);
          continue;
        }

        // Check for pending messages to include in the prompt
        const pending = await resolveMaybePromise(this.relay.recv(this.definition.name, 5));
        if (pending.length === 0 && this.hasAutonomousWork && !this.hasAutonomousWork(this.definition.name)) {
          this._state = 'idle';
          await sleep(LOOP_DELAY_MS, signal);
          continue;
        }
        let prompt = 'You have started. Begin working. Run `wanman recv` to check for new messages.';
        if (pending.length > 0) {
          const msgs = pending.map(m => {
            const text = typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload);
            return `[${m.priority}/${m.type}] ${m.from}: ${text}`;
          }).join('\n');
          prompt = `You have ${pending.length} pending message(s):\n\n${msgs}\n\nProcess these messages.`;
        }

        // Inject preamble context (session awareness on respawn)
        const preamble = this.preambleProvider
          ? await resolveMaybePromise(this.preambleProvider(this.definition.name))
          : undefined;
        if (preamble) {
          prompt += `\n\n${preamble}`;
        }

        // Inject goal for goal-driven agents (CEO)
        const goalPrompt = buildGoalPrompt(this.definition.name, this.goal)
        if (goalPrompt) {
          prompt += `\n\n${goalPrompt}`;
        }

        this._state = 'running';
        this.currentUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        await this.credentialManager?.ensureFresh();
        const runStartTime = Date.now();
        const runtime = resolveAgentRuntime(this.definition);
        const model = resolveModel(this.definition.model, runtime);
        const dynamicEnv = this.envProvider
          ? await resolveMaybePromise(this.envProvider(this.definition.name))
          : {};
        const runEnv = { ...this.extraEnv, ...dynamicEnv };
        const reasoningEffort = resolveCodexReasoningEffort(runEnv, runtime);
        const fast = resolveCodexFast(runEnv, runtime);
        log.info('spawning agent', {
          agent: this.definition.name,
          runtime,
          model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(fast ? { fast: true } : {}),
        });

        this.currentProcess = createAgentAdapter(runtime).startRun({
          runtime,
          model,
          reasoningEffort,
          fast,
          systemPrompt: this.definition.systemPrompt,
          cwd: this.workDir,
          initialMessage: prompt,
          env: runEnv,
          runAsUser: process.env['WANMAN_AGENT_USER'],
        });

        // Log tool calls so we can see what each agent is doing
        this.registerEventLogger(this.currentProcess);
        this.registerSessionIdCapture(this.currentProcess);

        // End stdin after initial message (single-shot per spawn)
        this.currentProcess.proc.stdin?.end();

        // Time budget: kill process if it exceeds the budget (autoresearch pattern)
        let budgetTimer: ReturnType<typeof setTimeout> | null = null;
        if (this.timeBudgetMs && this.currentProcess) {
          const proc = this.currentProcess;
          budgetTimer = setTimeout(() => {
            log.warn('time budget exceeded, killing agent', {
              agent: this.definition.name, budgetMs: this.timeBudgetMs,
            });
            proc.kill();
          }, this.timeBudgetMs);
        }

        const exitCode = await this.currentProcess.wait();
        if (budgetTimer) clearTimeout(budgetTimer);
        const runDuration = Date.now() - runStartTime;
        this.currentProcess = null;
        this._state = 'idle';
        await this.credentialManager?.syncFromFile();

        log.info('agent exited', { agent: this.definition.name, exitCode });

        // Fire run complete callback for feedback tracking
        try {
          this.onRunComplete?.({
            agentName: this.definition.name,
            exitCode,
            durationMs: runDuration,
            errored: exitCode !== 0,
            steerCount: this._steerCount,
            inputTokens: this.currentUsage.inputTokens,
            outputTokens: this.currentUsage.outputTokens,
            totalTokens: this.currentUsage.totalTokens,
          });
        } catch { /* non-fatal */ }
        this._steerCount = 0;

        if (signal.aborted) break;

        // Wait before respawning
        await sleep(RESPAWN_DELAY_MS, signal);
      } catch (err) {
        if (signal.aborted) break;
        this._state = 'error';
        log.error('agent loop error', {
          agent: this.definition.name,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(RESPAWN_DELAY_MS, signal);
      }
    }
  }

  /**
   * Handle a steer interrupt: kill current process, respawn with steer message.
   * This is the safest approach — avoids multiple stdin writes.
   */
  handleSteer(): void {
    const agent = this.definition.name;
    this._steerCount++;
    log.info('steer received', { agent, steerCount: this._steerCount });

    if (this.currentProcess) {
      log.info('killing current process for steer', { agent });
      this.currentProcess.kill();
      // The run loop will pick up the steer message on next iteration
    }

    // For on-demand / idle_cached agents, trigger a new run
    if (
      (this.definition.lifecycle === 'on-demand' || this.definition.lifecycle === 'idle_cached')
      && this._state === 'idle'
    ) {
      this.trigger();
    }
  }

  /**
   * Trigger an on-demand or idle_cached agent — spawn once, then return to
   * idle. For `idle_cached`, the previous session id is passed as
   * `resumeSessionId`; if Claude reports the session is unavailable, the
   * spawn is retried once without resume to force a cold-start.
   */
  async trigger(): Promise<void> {
    if (this._state === 'running') {
      log.warn('agent already running, ignoring trigger', { agent: this.definition.name });
      return;
    }

    this._state = 'running';
    this.currentUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const pending = await resolveMaybePromise(this.relay.recv(this.definition.name, 10));
    if (pending.length === 0) {
      this.setIdleIfActive();
      log.info('no pending messages, skipping trigger', { agent: this.definition.name });
      return;
    }

    const msgs = pending.map(m => {
      const text = typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload);
      return `[${m.priority}/${m.type}] ${m.from}: ${text}`;
    }).join('\n');
    let prompt = `You have been triggered. You have ${pending.length} pending message(s):\n\n${msgs}\n\nProcess these messages. Your task is complete once done.`;

    // Inject preamble context
    const preamble = this.preambleProvider
      ? await resolveMaybePromise(this.preambleProvider(this.definition.name))
      : undefined;
    if (preamble) {
      prompt += `\n\n${preamble}`;
    }

    await this.credentialManager?.ensureFresh();
    const runStartTime = Date.now();
    const runtime = resolveAgentRuntime(this.definition);
    const model = resolveModel(this.definition.model, runtime);
    const dynamicEnv = this.envProvider
      ? await resolveMaybePromise(this.envProvider(this.definition.name))
      : {};
    const runEnv = { ...this.extraEnv, ...dynamicEnv };
    const reasoningEffort = resolveCodexReasoningEffort(runEnv, runtime);
    const fast = resolveCodexFast(runEnv, runtime);
    // `idle_cached` agents always pass the captured Claude session id (if
    // any) — the constructor already rejected the lifecycle paired with a
    // non-Claude effective runtime, so we can rely on `runtime === 'claude'`
    // here without re-checking.
    const resumeSessionId = this.definition.lifecycle === 'idle_cached'
      ? this.lastSessionId ?? undefined
      : undefined;
    log.info('triggering agent', {
      agent: this.definition.name,
      lifecycle: this.definition.lifecycle,
      messageCount: pending.length,
      runtime,
      model,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(fast ? { fast: true } : {}),
    });

    let exitCode = await this.runOneShot({
      runtime, model, reasoningEffort, fast, prompt, runEnv, resumeSessionId,
    });

    // idle_cached fallback: if Claude reported the resumed session is missing,
    // retry once without resume so we don't strand the agent.
    if (
      this.definition.lifecycle === 'idle_cached'
      && resumeSessionId
      && this.lastSpawnResumeMissed
    ) {
      log.warn('resume session missing, falling back to cold start', {
        agent: this.definition.name,
        staleSessionId: resumeSessionId,
      });
      this.lastSessionId = null;
      this.lastSpawnResumeMissed = false;
      exitCode = await this.runOneShot({
        runtime, model, reasoningEffort, fast, prompt, runEnv,
      });
    }

    const runDuration = Date.now() - runStartTime;
    this.setIdleIfActive();
    await this.credentialManager?.syncFromFile();
    log.info('agent finished', {
      agent: this.definition.name,
      lifecycle: this.definition.lifecycle,
      exitCode,
      ...(this.lastSessionId && this.definition.lifecycle === 'idle_cached'
        ? { cachedSessionId: this.lastSessionId }
        : {}),
    });

    // Fire run complete callback for feedback tracking
    try {
      this.onRunComplete?.({
        agentName: this.definition.name,
        exitCode,
        durationMs: runDuration,
        errored: exitCode !== 0,
        steerCount: this._steerCount,
        inputTokens: this.currentUsage.inputTokens,
        outputTokens: this.currentUsage.outputTokens,
        totalTokens: this.currentUsage.totalTokens,
      });
    } catch { /* non-fatal */ }
    this._steerCount = 0;

    // Drain backlog: if more messages arrived while we were running, re-trigger
    const backlogCount = this.isStopped() ? 0 : this.relay.countPending(this.definition.name);
    if (backlogCount > 0) {
      log.info('backlog remaining after trigger, re-triggering', {
        agent: this.definition.name,
        pendingCount: backlogCount,
      });
      void this.trigger();
    }
  }

  /**
   * Register JSONL event logger on an agent runtime process.
   *
   * Handles two event formats (varies by Claude Code version):
   * - Flat: event.tool_name / event.tool_input at top level
   * - Structured: event.message.content[] with tool_use/text/tool_result blocks
   *
   * For non-Claude models (Qwen etc.), assistant_text and tool_result logs are
   * critical for debugging — they reveal model confusion and hidden errors.
   */
  private registerEventLogger(proc: AgentRunHandle): void {
    const agent = this.definition.name;
    proc.onEvent((event) => {
      this.updateTokenUsage(event);

      if (event.type === 'item.completed') {
        const item = event.item;
        const summary = typeof item === 'string'
          ? item.slice(0, 200)
          : JSON.stringify(item)?.slice(0, 200);
        log.info('item_completed', { agent, summary });
        return;
      }

      if (event.type === 'turn.failed' || event.type === 'error') {
        const detail = typeof event.error === 'string'
          ? event.error
          : JSON.stringify(event.error ?? event)?.slice(0, 300);
        log.warn('runtime_error', { agent, type: event.type, detail });
        return;
      }

      // Format 1: flat tool_name (common in newer Claude Code)
      if (typeof event.tool_name === 'string') {
        const input = event.tool_input as Record<string, unknown> | undefined;
        const summary = event.tool_name === 'Bash'
          ? (input?.command as string)?.slice(0, 200)
          : event.tool_name === 'Read'
            ? input?.file_path
            : event.tool_name === 'Write'
              ? input?.file_path
              : JSON.stringify(input)?.slice(0, 200);
        log.info('tool', { agent, tool: event.tool_name, summary });
        return;
      }

      // Format 2: structured message.content blocks
      const msg = event.message as { content?: Array<{ type: string; name?: string; input?: unknown; text?: string; content?: string; is_error?: boolean }> } | undefined;
      if (msg && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            const inputStr = block.input ? JSON.stringify(block.input).slice(0, 200) : '';
            log.info('tool_call', { agent, tool: block.name, input: inputStr });
          } else if (block.type === 'text' && block.text) {
            log.info('assistant_text', { agent, text: block.text.slice(0, 200) });
          } else if (block.type === 'tool_result') {
            log.info('tool_result', { agent, error: block.is_error, output: (block.content || '').slice(0, 300) });
          }
        }
        return;
      }

      // Final result (cost, duration, stop reason)
      if (event.type === 'result') {
        log.info('result', {
          agent,
          cost_usd: event.cost_usd,
          duration_ms: event.duration_ms,
          is_error: event.is_error,
          stop_reason: (event as Record<string, unknown>).stop_reason,
        });
      }
    });
  }

  /**
   * Subscribe to session-id and resume-miss signals from the adapter so
   * `idle_cached` agents can persist context across triggers. Adapters
   * without resume support simply never invoke these hooks, leaving
   * `lastSessionId` unchanged.
   */
  private registerSessionIdCapture(proc: AgentRunHandle): void {
    proc.onSessionId?.((sessionId) => {
      if (sessionId && this.lastSessionId !== sessionId) {
        this.lastSessionId = sessionId;
        log.debug?.('captured session id', {
          agent: this.definition.name,
          sessionId,
        });
      }
    });
    proc.onExit((_code) => {
      if (proc.resumeMissed?.()) this.lastSpawnResumeMissed = true;
    });
  }

  /**
   * Spawn one CLI subprocess, wait for it to exit, and clean up. Shared
   * between `trigger()` (single-shot) and the `idle_cached` cold-start
   * retry path so they apply the same time-budget and lifecycle rules.
   */
  private async runOneShot(opts: {
    runtime: 'claude' | 'codex';
    model: string;
    reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | undefined;
    fast: boolean;
    prompt: string;
    runEnv: Record<string, string>;
    resumeSessionId?: string;
  }): Promise<number> {
    this.currentProcess = createAgentAdapter(opts.runtime).startRun({
      runtime: opts.runtime,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      fast: opts.fast,
      systemPrompt: this.definition.systemPrompt,
      cwd: this.workDir,
      initialMessage: opts.prompt,
      ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
      env: opts.runEnv,
      runAsUser: process.env['WANMAN_AGENT_USER'],
    });

    this.registerEventLogger(this.currentProcess);
    this.registerSessionIdCapture(this.currentProcess);

    // End stdin — single-shot execution
    this.currentProcess.proc.stdin?.end();

    let budgetTimer: ReturnType<typeof setTimeout> | null = null;
    if (this.timeBudgetMs && this.currentProcess) {
      const proc = this.currentProcess;
      budgetTimer = setTimeout(() => {
        log.warn('time budget exceeded, killing agent', {
          agent: this.definition.name, budgetMs: this.timeBudgetMs,
        });
        proc.kill();
      }, this.timeBudgetMs);
    }

    const exitCode = await this.currentProcess.wait();
    if (budgetTimer) clearTimeout(budgetTimer);
    this.currentProcess = null;
    return exitCode;
  }

  private updateTokenUsage(event: AgentRunEvent): void {
    const usage = extractTokenUsage(event);
    if (!usage) return;
    this.currentUsage = usage;
  }

  /** Pause the agent — SIGSTOP the current process, prevent respawn. */
  pause(): void {
    if (this._state !== 'running') return;
    if (this.currentProcess?.proc?.pid) {
      try { process.kill(this.currentProcess.proc.pid, 'SIGSTOP'); } catch { /* ignore */ }
    }
    this._state = 'paused';
    log.info('paused', { agent: this.definition.name });
  }

  /** Resume the agent — SIGCONT the current process. */
  resume(): void {
    if (this._state !== 'paused') return;
    if (this.currentProcess?.proc?.pid) {
      try { process.kill(this.currentProcess.proc.pid, 'SIGCONT'); } catch { /* ignore */ }
    }
    this._state = 'running';
    log.info('resumed', { agent: this.definition.name });
  }

  /** Stop the agent. */
  stop(): void {
    this.abortController?.abort();
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }
    this._state = 'stopped';
    log.info('stopped', { agent: this.definition.name });
  }
}

function extractTokenUsage(event: AgentRunEvent): TokenUsageSnapshot | null {
  const records: unknown[] = [
    event,
    event.usage,
    event.result,
    event.item,
    event.message,
    event.delta,
    event.payload,
    (event.payload as Record<string, unknown> | undefined)?.info,
    (event.result as Record<string, unknown> | undefined)?.usage,
    (event.item as Record<string, unknown> | undefined)?.usage,
    (event.message as Record<string, unknown> | undefined)?.usage,
    (event.delta as Record<string, unknown> | undefined)?.usage,
    (event.payload as Record<string, unknown> | undefined)?.usage,
  ];

  for (const record of records) {
    const usage = readTokenUsageRecord(record);
    if (usage) return usage;
  }
  return null;
}

function readTokenUsageRecord(value: unknown): TokenUsageSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const nestedInfo = record['info'] as unknown;
  const inputTokens =
    pickNumber(record, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']) ??
    pickNumber(nestedInfo, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']) ??
    pickNumber(record['input'] as unknown, ['tokens']) ??
    null;
  const outputTokens =
    pickNumber(record, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']) ??
    pickNumber(nestedInfo, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']) ??
    pickNumber(record['output'] as unknown, ['tokens']) ??
    null;
  const totalTokens =
    pickNumber(record, ['totalTokens', 'total_tokens', 'totalTokenUsage', 'total_token_usage', 'lastTokenUsage', 'last_token_usage']) ??
    pickNumber(nestedInfo, ['totalTokens', 'total_tokens', 'totalTokenUsage', 'total_token_usage', 'lastTokenUsage', 'last_token_usage']) ??
    null;

  if (inputTokens === null && outputTokens === null && totalTokens === null) return null;

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0)),
  };
}

function pickNumber(value: unknown, keys: string[]): number | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  }
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
