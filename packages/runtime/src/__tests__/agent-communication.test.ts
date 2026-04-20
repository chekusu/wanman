/**
 * Agent inter-communication E2E tests.
 *
 * Tests the complete message flow through real MessageStore, ContextStore,
 * and Relay — only Claude Code processes and HTTP server are mocked.
 *
 * Scenarios:
 *   1. Full message lifecycle: send → recv → reply → recv reply
 *   2. Steer priority ordering and interrupt callback
 *   3. External event routing to subscribed agents
 *   4. ContextStore cross-agent data sharing
 *   5. Production agent config loading and multi-agent routing
 *   6. Message delivery guarantees (delivered flag, batch marking)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { AgentMatrixConfig, AgentMessage, JsonRpcRequest } from '@wanman/core'
import {
  RPC_METHODS,
  RPC_ERRORS,
} from '@wanman/core'
import { Supervisor } from '../supervisor.js'
import { LOOPBACK_LISTEN_AVAILABLE } from './loopback-capability.js'

// Mock http-server
vi.mock('../http-server.js', () => ({
  createHttpServer: vi.fn(() => ({
    close: (cb: () => void) => cb(),
  })),
}))

// Track steer calls per agent
const steerCalls: string[] = []

// Mock agent-process
vi.mock('../agent-process.js', () => {
  class MockAgentProcess {
    definition: { name: string; lifecycle: string; model: string }
    state = 'idle'
    constructor(def: { name: string; lifecycle: string; model: string }) {
      this.definition = def
    }
    async start() { this.state = 'running' }
    stop() { this.state = 'stopped' }
    handleSteer() { steerCalls.push(this.definition.name) }
  }
  return { AgentProcess: MockAgentProcess }
})

// Suppress logger output
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

function rpc(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: '2.0', id: 1, method, params }
}

function sendMsg(
  sv: Supervisor,
  from: string,
  to: string,
  payload: unknown,
  priority: 'steer' | 'normal' = 'normal',
) {
  return sv.handleRpc(rpc(RPC_METHODS.AGENT_SEND, { from, to, type: 'message', payload, priority }))
}

function recvMsgs(sv: Supervisor, agent: string, limit = 10) {
  const res = sv.handleRpc(rpc(RPC_METHODS.AGENT_RECV, { agent, limit }))
  return (res.result as { messages: AgentMessage[] }).messages
}

function setContext(sv: Supervisor, key: string, value: string, agent: string) {
  return sv.handleRpc(rpc(RPC_METHODS.CONTEXT_SET, { key, value, agent }))
}

function getContext(sv: Supervisor, key: string) {
  const res = sv.handleRpc(rpc(RPC_METHODS.CONTEXT_GET, { key }))
  return res.result as { key: string; value: string; updatedBy: string; updatedAt: number } | null
}

// =========================================================================
// Test suites
// =========================================================================

describe('Agent Inter-Communication E2E', () => {
  describe('Full message lifecycle with test agents', () => {
    let sv: Supervisor

    beforeEach(async () => {
      steerCalls.length = 0
      sv = new Supervisor({
        agents: [
          { name: 'echo', lifecycle: '24/7', model: 'haiku', systemPrompt: 'echo' },
          { name: 'ping', lifecycle: 'on-demand', model: 'haiku', systemPrompt: 'ping' },
        ],
        dbPath: ':memory:',
        port: 0,
      })
      await sv.start()
    })

    afterEach(async () => { await sv.shutdown() })

    it('should deliver a message from echo to ping and back', () => {
      // echo sends to ping
      const sendRes = sendMsg(sv, 'echo', 'ping', 'hello from echo')
      expect(sendRes.error).toBeUndefined()
      expect((sendRes.result as { status: string }).status).toBe('queued')

      // ping receives the message
      const msgs = recvMsgs(sv, 'ping')
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.from).toBe('echo')
      expect(msgs[0]!.payload).toBe('hello from echo')
      expect(msgs[0]!.priority).toBe('normal')

      // ping replies back
      sendMsg(sv, 'ping', 'echo', 'pong')

      // echo receives the reply
      const replies = recvMsgs(sv, 'echo')
      expect(replies).toHaveLength(1)
      expect(replies[0]!.from).toBe('ping')
      expect(replies[0]!.payload).toBe('pong')
    })

    it('should not double-deliver messages (delivered flag)', () => {
      sendMsg(sv, 'echo', 'ping', 'msg1')
      sendMsg(sv, 'echo', 'ping', 'msg2')

      // First recv gets both
      const first = recvMsgs(sv, 'ping')
      expect(first).toHaveLength(2)

      // Second recv gets nothing (already delivered)
      const second = recvMsgs(sv, 'ping')
      expect(second).toHaveLength(0)
    })

    it('should respect recv limit', () => {
      for (let i = 0; i < 5; i++) {
        sendMsg(sv, 'echo', 'ping', `msg-${i}`)
      }

      // Recv with limit 2
      const batch1 = recvMsgs(sv, 'ping', 2)
      expect(batch1).toHaveLength(2)
      expect(batch1[0]!.payload).toBe('msg-0')
      expect(batch1[1]!.payload).toBe('msg-1')

      // Recv remaining
      const batch2 = recvMsgs(sv, 'ping', 10)
      expect(batch2).toHaveLength(3)
      expect(batch2[0]!.payload).toBe('msg-2')
    })
  })

  describe('Steer priority and interrupt', () => {
    let sv: Supervisor

    beforeEach(async () => {
      steerCalls.length = 0
      sv = new Supervisor({
        agents: [
          { name: 'finance', lifecycle: '24/7', model: 'haiku', systemPrompt: 'finance' },
          { name: 'devops', lifecycle: '24/7', model: 'haiku', systemPrompt: 'devops' },
          { name: 'ceo', lifecycle: '24/7', model: 'sonnet', systemPrompt: 'ceo' },
        ],
        dbPath: ':memory:',
        port: 0,
      })
      await sv.start()
    })

    afterEach(async () => { await sv.shutdown() })

    it('should prioritize steer messages over normal in recv', () => {
      // Send normal first, then steer
      sendMsg(sv, 'ceo', 'devops', 'routine check', 'normal')
      sendMsg(sv, 'finance', 'devops', 'URGENT: revenue dropped 20%', 'steer')
      sendMsg(sv, 'ceo', 'devops', 'weekly report', 'normal')

      const msgs = recvMsgs(sv, 'devops')
      expect(msgs).toHaveLength(3)
      // Steer message comes first regardless of insertion order
      expect(msgs[0]!.priority).toBe('steer')
      expect(msgs[0]!.from).toBe('finance')
      // Followed by normal in timestamp order
      expect(msgs[1]!.priority).toBe('normal')
      expect(msgs[2]!.priority).toBe('normal')
    })

    it('should trigger steer callback on the target agent', () => {
      sendMsg(sv, 'finance', 'devops', 'check outage', 'steer')

      expect(steerCalls).toContain('devops')
    })

    it('should not trigger steer callback for normal messages', () => {
      sendMsg(sv, 'finance', 'devops', 'routine update', 'normal')

      expect(steerCalls).not.toContain('devops')
    })

    it('should support escalation pattern (any agent → ceo via steer)', () => {
      sendMsg(sv, 'finance', 'ceo', 'MRR dropped 25%', 'steer')
      sendMsg(sv, 'devops', 'ceo', 'saifuri /api/wallet 500 errors', 'steer')

      const msgs = recvMsgs(sv, 'ceo')
      expect(msgs).toHaveLength(2)
      expect(msgs.every(m => m.priority === 'steer')).toBe(true)

      const sources = msgs.map(m => m.from)
      expect(sources).toContain('finance')
      expect(sources).toContain('devops')
    })
  })

  describe('External event routing', () => {
    let sv: Supervisor

    beforeEach(async () => {
      steerCalls.length = 0
      sv = new Supervisor({
        agents: [
          { name: 'finance', lifecycle: '24/7', model: 'haiku', systemPrompt: 'finance', events: ['stripe_webhook'] },
          { name: 'devops', lifecycle: '24/7', model: 'haiku', systemPrompt: 'devops', events: ['deploy_webhook'] },
          { name: 'feedback', lifecycle: '24/7', model: 'haiku', systemPrompt: 'feedback', events: ['github_issue', 'email_webhook'] },
          { name: 'ceo', lifecycle: '24/7', model: 'sonnet', systemPrompt: 'ceo', events: ['human_query'] },
        ],
        dbPath: ':memory:',
        port: 0,
      })
      await sv.start()
    })

    afterEach(async () => { await sv.shutdown() })

    it('should route stripe_webhook only to finance agent', () => {
      sv.handleExternalEvent({
        type: 'stripe_webhook',
        source: 'stripe',
        payload: { event: 'charge.refunded', amount: 4999 },
        timestamp: Date.now(),
      })

      expect(recvMsgs(sv, 'finance')).toHaveLength(1)
      expect(recvMsgs(sv, 'devops')).toHaveLength(0)
      expect(recvMsgs(sv, 'feedback')).toHaveLength(0)
      expect(recvMsgs(sv, 'ceo')).toHaveLength(0)
    })

    it('should route deploy_webhook only to devops agent', () => {
      sv.handleExternalEvent({
        type: 'deploy_webhook',
        source: 'github',
        payload: { repo: 'saifuri', status: 'success' },
        timestamp: Date.now(),
      })

      expect(recvMsgs(sv, 'devops')).toHaveLength(1)
      expect(recvMsgs(sv, 'finance')).toHaveLength(0)
    })

    it('should route github_issue to feedback agent', () => {
      sv.handleExternalEvent({
        type: 'github_issue',
        source: 'github',
        payload: { repo: 'menkr', issue: 42, title: 'Login broken' },
        timestamp: Date.now(),
      })

      const msgs = recvMsgs(sv, 'feedback')
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.type).toBe('event')
      const payloadStr = JSON.stringify(msgs[0]!.payload)
      expect(payloadStr).toContain('github_issue')
      expect(payloadStr).toContain('Login broken')
    })

    it('should route human_query to ceo agent', () => {
      sv.handleExternalEvent({
        type: 'human_query',
        source: 'dashboard',
        payload: { question: 'What is our current MRR?' },
        timestamp: Date.now(),
      })

      const msgs = recvMsgs(sv, 'ceo')
      expect(msgs).toHaveLength(1)
      const payloadStr = JSON.stringify(msgs[0]!.payload)
      expect(payloadStr).toContain('human_query')
    })

    it('should route to multiple agents subscribed to the same event', async () => {
      // Create a config where two agents subscribe to the same event
      const sv2 = new Supervisor({
        agents: [
          { name: 'a', lifecycle: '24/7', model: 'haiku', systemPrompt: 'a', events: ['shared_event'] },
          { name: 'b', lifecycle: '24/7', model: 'haiku', systemPrompt: 'b', events: ['shared_event'] },
          { name: 'c', lifecycle: '24/7', model: 'haiku', systemPrompt: 'c' },
        ],
        dbPath: ':memory:',
        port: 0,
      })
      await sv2.start()

      sv2.handleExternalEvent({
        type: 'shared_event',
        source: 'test',
        payload: { data: 'broadcast' },
        timestamp: Date.now(),
      })

      // Both a and b should receive the event, c should not
      const msgsA = recvMsgs(sv2, 'a')
      const msgsB = recvMsgs(sv2, 'b')
      const msgsC = recvMsgs(sv2, 'c')

      expect(msgsA).toHaveLength(1)
      const payloadA = JSON.stringify(msgsA[0]!.payload)
      expect(payloadA).toContain('shared_event')
      expect(msgsB).toHaveLength(1)
      const payloadB = JSON.stringify(msgsB[0]!.payload)
      expect(payloadB).toContain('shared_event')
      expect(msgsC).toHaveLength(0)

      await sv2.shutdown()
    })

    it('should ignore events with no subscribers', () => {
      sv.handleExternalEvent({
        type: 'unknown_event',
        source: 'test',
        payload: {},
        timestamp: Date.now(),
      })

      // No agent should have messages
      expect(recvMsgs(sv, 'finance')).toHaveLength(0)
      expect(recvMsgs(sv, 'devops')).toHaveLength(0)
      expect(recvMsgs(sv, 'feedback')).toHaveLength(0)
      expect(recvMsgs(sv, 'ceo')).toHaveLength(0)
    })

    it('should include event payload in the message payload', () => {
      sv.handleExternalEvent({
        type: 'stripe_webhook',
        source: 'stripe',
        payload: { event: 'payment_intent.succeeded', customer: 'cus_123', amount: 9900 },
        timestamp: Date.now(),
      })

      const msgs = recvMsgs(sv, 'finance')
      const payloadStr = JSON.stringify(msgs[0]!.payload)
      expect(payloadStr).toContain('payment_intent.succeeded')
      expect(payloadStr).toContain('cus_123')
      expect(payloadStr).toContain('9900')
      expect(msgs[0]!.from).toBe('system')
    })
  })

  describe('ContextStore cross-agent sharing', () => {
    let sv: Supervisor

    beforeEach(async () => {
      sv = new Supervisor({
        agents: [
          { name: 'finance', lifecycle: '24/7', model: 'haiku', systemPrompt: 'finance' },
          { name: 'devops', lifecycle: '24/7', model: 'haiku', systemPrompt: 'devops' },
          { name: 'ceo', lifecycle: '24/7', model: 'sonnet', systemPrompt: 'ceo' },
        ],
        dbPath: ':memory:',
        port: 0,
      })
      await sv.start()
    })

    afterEach(async () => { await sv.shutdown() })

    it('should allow finance to set MRR and ceo to read it', () => {
      setContext(sv, 'mrr', '12500', 'finance')
      const entry = getContext(sv, 'mrr')

      expect(entry).not.toBeNull()
      expect(entry!.value).toBe('12500')
      expect(entry!.updatedBy).toBe('finance')
    })

    it('should allow devops to set system_status and ceo to read it', () => {
      setContext(sv, 'system_status', 'all_healthy', 'devops')
      const entry = getContext(sv, 'system_status')

      expect(entry!.value).toBe('all_healthy')
      expect(entry!.updatedBy).toBe('devops')
    })

    it('should allow overwriting context values', () => {
      setContext(sv, 'mrr', '10000', 'finance')
      setContext(sv, 'mrr', '12500', 'finance')

      const entry = getContext(sv, 'mrr')
      expect(entry!.value).toBe('12500')
    })

    it('should track which agent last updated a key', () => {
      setContext(sv, 'alert_level', 'normal', 'devops')
      setContext(sv, 'alert_level', 'critical', 'ceo')

      const entry = getContext(sv, 'alert_level')
      expect(entry!.value).toBe('critical')
      expect(entry!.updatedBy).toBe('ceo')
    })

    it('should return null for non-existent keys', () => {
      const entry = getContext(sv, 'nonexistent')
      expect(entry).toBeNull()
    })
  })

  // Skipped in OSS: the original PRODUCTION_AGENTS preset (ceo/finance/devops/dev/...)
  // lived in the proprietary @wanman/core and was removed during the OSS split.
  // The scenarios below reference those agent names directly (saifuri incident, MRR,
  // etc.) and would need a rewrite to be framework-generic. Keeping the block as
  // `describe.skip` documents intent without deleting the SaaS reference scenario.
  describe.skip('Production agent config (requires SaaS PRODUCTION_AGENTS preset)', () => {
    let sv: Supervisor

    beforeEach(async () => {
      steerCalls.length = 0
      sv = new Supervisor({
        agents: [],
        dbPath: ':memory:',
        port: 0,
      })
      await sv.start()
    })

    afterEach(async () => { await sv.shutdown() })

    it('should load all 7 production agents', () => {
      const res = sv.handleRpc(rpc(RPC_METHODS.AGENT_LIST))
      const agents = (res.result as { agents: Array<{ name: string }> }).agents
      expect(agents).toHaveLength(7)

      const names = agents.map(a => a.name).sort()
      expect(names).toEqual(['ceo', 'cto', 'dev', 'devops', 'feedback', 'finance', 'marketing'])
    })

    it('should correctly set lifecycle types', () => {
      const res = sv.handleRpc(rpc(RPC_METHODS.AGENT_LIST))
      const agents = (res.result as { agents: Array<{ name: string; lifecycle: string }> }).agents

      const devAgent = agents.find(a => a.name === 'dev')
      expect(devAgent!.lifecycle).toBe('on-demand')

      const ceoAgent = agents.find(a => a.name === 'ceo')
      expect(ceoAgent!.lifecycle).toBe('24/7')
    })

    it('should correctly set model tiers', () => {
      const res = sv.handleRpc(rpc(RPC_METHODS.AGENT_LIST))
      const agents = (res.result as { agents: Array<{ name: string; model: string }> }).agents

      // All agents use the model from config
      for (const agent of agents) {
        expect(typeof agent.model).toBe('string')
        expect(agent.model.length).toBeGreaterThan(0)
      }
    })

    it('should simulate the design doc scenario: revenue drop → diagnosis → fix', () => {
      // Step 1: Stripe webhook triggers Finance Agent
      sv.handleExternalEvent({
        type: 'stripe_webhook',
        source: 'stripe',
        payload: { event: 'charge.refunded', product: 'saifuri', refundRate: 0.15 },
        timestamp: Date.now(),
      })

      // Finance receives the webhook
      const financeInbox = recvMsgs(sv, 'finance')
      expect(financeInbox).toHaveLength(1)

      // Step 2: Finance Agent detects anomaly and steers DevOps
      sendMsg(sv, 'finance', 'devops', '紧急: saifuri 退款率飙升至 15%，请检查线上故障', 'steer')
      expect(steerCalls).toContain('devops')

      // Step 3: DevOps receives the alert
      const devopsInbox = recvMsgs(sv, 'devops')
      expect(devopsInbox).toHaveLength(1)
      expect(devopsInbox[0]!.priority).toBe('steer')

      // Step 4: DevOps diagnoses and steers Dev Agent
      sendMsg(sv, 'devops', 'dev', '紧急修复: saifuri /api/wallet 500 错误率 40%', 'steer')
      expect(steerCalls).toContain('dev')

      // Step 5: DevOps escalates to CEO
      sendMsg(sv, 'devops', 'ceo', '紧急: saifuri 线上故障，/api/wallet 500 错误率 40%', 'steer')
      expect(steerCalls).toContain('ceo')

      // Step 6: Dev Agent receives the task
      const devInbox = recvMsgs(sv, 'dev')
      expect(devInbox).toHaveLength(1)
      expect(devInbox[0]!.payload).toContain('saifuri')

      // Step 7: Dev reports back with fix
      sendMsg(sv, 'dev', 'devops', '修复 PR #42 已创建: saifuri /api/wallet 参数校验修复', 'normal')
      sendMsg(sv, 'dev', 'ceo', '修复完成: saifuri /api/wallet 500 bug，PR #42', 'normal')

      // Step 8: CEO receives all updates
      const ceoInbox = recvMsgs(sv, 'ceo')
      expect(ceoInbox).toHaveLength(2) // steer from devops + normal from dev

      // Step 9: DevOps receives the fix notification
      const devopsInbox2 = recvMsgs(sv, 'devops')
      expect(devopsInbox2).toHaveLength(1)
      expect(devopsInbox2[0]!.payload).toContain('PR #42')

      // Step 10: Verify context was usable throughout
      setContext(sv, 'saifuri_status', 'incident_resolved', 'devops')
      setContext(sv, 'saifuri_fix_pr', '#42', 'dev')

      const status = getContext(sv, 'saifuri_status')
      const fixPr = getContext(sv, 'saifuri_fix_pr')
      expect(status!.value).toBe('incident_resolved')
      expect(fixPr!.value).toBe('#42')
    })

    it('should simulate CEO morning briefing data gathering', () => {
      // Agents populate context overnight
      setContext(sv, 'mrr', '15200', 'finance')
      setContext(sv, 'system_status', 'all_healthy', 'devops')
      setContext(sv, 'feedback_volume', '23 issues, 5 emails', 'feedback')

      // CEO Agent reads all context values
      const mrr = getContext(sv, 'mrr')
      const systemStatus = getContext(sv, 'system_status')
      const feedbackVolume = getContext(sv, 'feedback_volume')

      expect(mrr!.value).toBe('15200')
      expect(mrr!.updatedBy).toBe('finance')
      expect(systemStatus!.value).toBe('all_healthy')
      expect(feedbackVolume!.value).toContain('23 issues')
    })
  })

  describe('Edge cases', () => {
    let sv: Supervisor

    beforeEach(async () => {
      steerCalls.length = 0
      sv = new Supervisor({
        agents: [
          { name: 'a', lifecycle: '24/7', model: 'haiku', systemPrompt: 'a' },
          { name: 'b', lifecycle: '24/7', model: 'haiku', systemPrompt: 'b' },
        ],
        dbPath: ':memory:',
        port: 0,
      })
      await sv.start()
    })

    afterEach(async () => { await sv.shutdown() })

    it('should handle agent sending message to itself', () => {
      sendMsg(sv, 'a', 'a', 'note to self')

      const msgs = recvMsgs(sv, 'a')
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.from).toBe('a')
      expect(msgs[0]!.to).toBe('a')
    })

    it('should handle rapid-fire messages', () => {
      for (let i = 0; i < 50; i++) {
        sendMsg(sv, 'a', 'b', `msg-${i}`)
      }

      const msgs = recvMsgs(sv, 'b', 100)
      expect(msgs).toHaveLength(50)
      expect(msgs[0]!.payload).toBe('msg-0')
      expect(msgs[49]!.payload).toBe('msg-49')
    })

    it('should handle undefined payload', () => {
      const res = sv.handleRpc(rpc(RPC_METHODS.AGENT_SEND, {
        from: 'a',
        to: 'b',
      }))
      // undefined payload should be rejected (validation in supervisor)
      expect(res.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
    })

    it('should handle event.push via RPC', () => {
      // Using event.push RPC method (how Control Plane would send events)
      const config: AgentMatrixConfig = {
        agents: [
          { name: 'x', lifecycle: '24/7', model: 'haiku', systemPrompt: 'x', events: ['test_event'] },
        ],
        dbPath: ':memory:',
        port: 0,
      }
      const sv2 = new Supervisor(config)
      // We need to call start to populate the agents map
      sv2.start()

      const res = sv2.handleRpc(rpc(RPC_METHODS.EVENT_PUSH, {
        type: 'test_event',
        source: 'test',
        payload: { data: 123 },
      }))
      expect(res.error).toBeUndefined()
      expect((res.result as { status: string }).status).toBe('accepted')

      const msgs = recvMsgs(sv2, 'x')
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.type).toBe('event')
      const payloadStr = JSON.stringify(msgs[0]!.payload)
      expect(payloadStr).toContain('test_event')

      sv2.shutdown()
    })

    it('should handle health check returning all agent states', () => {
      const res = sv.handleRpc(rpc(RPC_METHODS.HEALTH_CHECK))
      const health = res.result as { status: string; agents: Array<{ name: string; state: string }>; timestamp: string }

      expect(health.status).toBe('ok')
      expect(health.agents).toHaveLength(2)
      expect(health.timestamp).toBeTruthy()
      // Agents should have their mock state
      expect(health.agents[0]!.name).toBe('a')
      expect(health.agents[1]!.name).toBe('b')
    })
  })
})

// =========================================================================
// Sandbank Relay Mode
// =========================================================================

const describeIfLoopback = LOOPBACK_LISTEN_AVAILABLE ? describe : describe.skip

describeIfLoopback('Sandbank Relay Mode', () => {
  let sv: Supervisor

  beforeEach(async () => {
    steerCalls.length = 0
    sv = new Supervisor({
      agents: [
        { name: 'echo', lifecycle: '24/7', model: 'haiku', systemPrompt: 'echo' },
        { name: 'ping', lifecycle: 'on-demand', model: 'haiku', systemPrompt: 'ping' },
      ],
      port: 0,
      relay: { port: 0 },
    })
    await sv.start()
  })

  afterEach(async () => { await sv.shutdown() })

  it('should send and receive messages through Sandbank relay', async () => {
    // echo sends to ping
    const sendRes = sv.handleRpc(rpc(RPC_METHODS.AGENT_SEND, {
      from: 'echo', to: 'ping', type: 'message', payload: 'hello via relay',
    }))
    expect(sendRes.error).toBeUndefined()
    expect((sendRes.result as { status: string }).status).toBe('queued')

    // Small delay to let the async HTTP send complete
    await new Promise(r => setTimeout(r, 100))

    // ping receives via handleRpcAsync (relay recv is async)
    const recvRes = await sv.handleRpcAsync(rpc(RPC_METHODS.AGENT_RECV, { agent: 'ping', limit: 10 }))
    const msgs = (recvRes.result as { messages: AgentMessage[] }).messages
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.from).toBe('echo')
    expect(msgs[0]!.payload).toBe('hello via relay')
  })

  it('should handle context operations through Sandbank relay', async () => {
    // Set context via handleRpcAsync (async context bridge)
    // Use a registered agent name (echo) — unregistered names get 403 from the relay
    const setRes = await sv.handleRpcAsync(rpc(RPC_METHODS.CONTEXT_SET, {
      key: 'mrr', value: '15000', agent: 'echo',
    }))
    expect(setRes.error).toBeUndefined()
    expect((setRes.result as { status: string }).status).toBe('ok')

    // Get context via handleRpcAsync
    const getRes = await sv.handleRpcAsync(rpc(RPC_METHODS.CONTEXT_GET, { key: 'mrr' }))
    expect(getRes.error).toBeUndefined()
    const entry = getRes.result as { key: string; value: string } | null
    expect(entry).not.toBeNull()
    expect(entry!.value).toBe('15000')
  })

  it('should list context entries through Sandbank relay', async () => {
    // Set two context entries
    await sv.handleRpcAsync(rpc(RPC_METHODS.CONTEXT_SET, { key: 'k1', value: 'v1', agent: 'echo' }))
    await sv.handleRpcAsync(rpc(RPC_METHODS.CONTEXT_SET, { key: 'k2', value: 'v2', agent: 'ping' }))

    // List all context entries
    const listRes = await sv.handleRpcAsync(rpc(RPC_METHODS.CONTEXT_LIST, {}))
    expect(listRes.error).toBeUndefined()
    const entries = (listRes.result as { entries: Array<{ key: string; value: string }> }).entries
    expect(entries).toHaveLength(2)
    const keys = entries.map(e => e.key).sort()
    expect(keys).toEqual(['k1', 'k2'])
  })

  it('should trigger steer callback on steer messages', async () => {
    sv.handleRpc(rpc(RPC_METHODS.AGENT_SEND, {
      from: 'echo', to: 'ping', type: 'message', payload: 'urgent', priority: 'steer',
    }))

    // Steer callback fires synchronously in send()
    expect(steerCalls).toContain('ping')
  })

  it('should support round-trip messaging', async () => {
    // echo -> ping
    sv.handleRpc(rpc(RPC_METHODS.AGENT_SEND, {
      from: 'echo', to: 'ping', type: 'message', payload: 'hello',
    }))
    await new Promise(r => setTimeout(r, 100))

    const recvRes1 = await sv.handleRpcAsync(rpc(RPC_METHODS.AGENT_RECV, { agent: 'ping', limit: 10 }))
    const msgs1 = (recvRes1.result as { messages: AgentMessage[] }).messages
    expect(msgs1).toHaveLength(1)
    expect(msgs1[0]!.payload).toBe('hello')

    // ping -> echo
    sv.handleRpc(rpc(RPC_METHODS.AGENT_SEND, {
      from: 'ping', to: 'echo', type: 'message', payload: 'world',
    }))
    await new Promise(r => setTimeout(r, 100))

    const recvRes2 = await sv.handleRpcAsync(rpc(RPC_METHODS.AGENT_RECV, { agent: 'echo', limit: 10 }))
    const msgs2 = (recvRes2.result as { messages: AgentMessage[] }).messages
    expect(msgs2).toHaveLength(1)
    expect(msgs2[0]!.payload).toBe('world')
  })
})
