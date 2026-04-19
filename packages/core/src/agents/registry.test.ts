import { describe, it, expect } from 'vitest'
import {
  ECHO_AGENT, PING_AGENT, TEST_AGENTS,
} from './registry.js'

describe('ECHO_AGENT', () => {
  it('should have correct name', () => {
    expect(ECHO_AGENT.name).toBe('echo')
  })

  it('should be a 24/7 agent', () => {
    expect(ECHO_AGENT.lifecycle).toBe('24/7')
  })

  it('should use haiku model', () => {
    expect(ECHO_AGENT.model).toBe('haiku')
  })

  it('should have a system prompt with wanman CLI instructions', () => {
    expect(ECHO_AGENT.systemPrompt).toContain('wanman recv')
    expect(ECHO_AGENT.systemPrompt).toContain('wanman send')
    expect(ECHO_AGENT.systemPrompt).toContain('echo')
  })
})

describe('PING_AGENT', () => {
  it('should have correct name', () => {
    expect(PING_AGENT.name).toBe('ping')
  })

  it('should be an on-demand agent', () => {
    expect(PING_AGENT.lifecycle).toBe('on-demand')
  })

  it('should use haiku model', () => {
    expect(PING_AGENT.model).toBe('haiku')
  })

  it('should have a system prompt mentioning pong', () => {
    expect(PING_AGENT.systemPrompt).toContain('pong')
  })
})

describe('TEST_AGENTS', () => {
  it('should contain both echo and ping agents', () => {
    expect(TEST_AGENTS).toHaveLength(2)
    expect(TEST_AGENTS[0]).toBe(ECHO_AGENT)
    expect(TEST_AGENTS[1]).toBe(PING_AGENT)
  })

  it('should have unique names', () => {
    const names = TEST_AGENTS.map(a => a.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
