/**
 * Unit tests for the agents command.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../transport.js', () => ({
  rpcCall: vi.fn(),
}))

import { agentsCommand } from './agents.js'
import { rpcCall } from '../transport.js'

const mockRpcCall = vi.mocked(rpcCall)

describe('agentsCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
  })

  it('should list agents', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0', id: 1,
      result: {
        agents: [
          { name: 'echo', state: 'running', lifecycle: '24/7', model: 'haiku' },
          { name: 'ping', state: 'idle', lifecycle: 'on-demand', model: 'haiku' },
        ],
      },
    })

    await agentsCommand()

    expect(console.log).toHaveBeenCalledWith('Agent Matrix:')
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('echo'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('ping'))
  })

  it('should show running icon for running agents', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0', id: 1,
      result: {
        agents: [{ name: 'echo', state: 'running', lifecycle: '24/7', model: 'haiku' }],
      },
    })

    await agentsCommand()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('*'))
  })

  it('should show idle icon for idle agents', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0', id: 1,
      result: {
        agents: [{ name: 'ping', state: 'idle', lifecycle: 'on-demand', model: 'haiku' }],
      },
    })

    await agentsCommand()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('-'))
  })

  it('should handle no agents', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0', id: 1,
      result: { agents: [] },
    })

    await agentsCommand()
    expect(console.log).toHaveBeenCalledWith('No agents configured.')
  })

  it('should exit on RPC error', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0', id: 1,
      error: { code: -32603, message: 'failed' },
    })

    await expect(agentsCommand()).rejects.toThrow('process.exit')
  })

  it('spawns a dynamic agent clone', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0', id: 1,
      result: { name: 'feedback-2' },
    })

    await agentsCommand(['spawn', 'feedback', 'feedback-2'])

    expect(mockRpcCall).toHaveBeenCalledWith('agent.spawn', { template: 'feedback', name: 'feedback-2' })
    expect(console.log).toHaveBeenCalledWith('Spawned: feedback-2 (clone of feedback)')
  })

  it('requires a spawn template', async () => {
    await expect(agentsCommand(['spawn'])).rejects.toThrow('process.exit')

    expect(mockRpcCall).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith('Usage: wanman agents spawn <template> [name]')
  })

  it('destroys a dynamic agent clone', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0', id: 1,
      result: { destroyed: true },
    })

    await agentsCommand(['destroy', 'feedback-2'])

    expect(mockRpcCall).toHaveBeenCalledWith('agent.destroy', { name: 'feedback-2' })
    expect(console.log).toHaveBeenCalledWith('Destroyed: feedback-2')
  })

  it('exits when destroy is rejected by the supervisor', async () => {
    mockRpcCall.mockResolvedValue({
      jsonrpc: '2.0', id: 1,
      result: { destroyed: false },
    })

    await expect(agentsCommand(['destroy', 'ceo'])).rejects.toThrow('process.exit')

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Cannot destroy 'ceo'"))
  })
})
