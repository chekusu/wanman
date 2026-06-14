/**
 * Unit tests for HTTP server — tests actual HTTP endpoints.
 */

import { describe, it, expect, afterEach } from 'vitest'
import type * as http from 'http'
import type { JsonRpcRequest, JsonRpcResponse, ExternalEvent } from '@wanman/core'
import { createHttpServer } from '../http-server.js'
import { LOOPBACK_LISTEN_AVAILABLE } from './loopback-capability.js'

let server: http.Server | null = null
let port: number
const describeIfLoopback = LOOPBACK_LISTEN_AVAILABLE ? describe : describe.skip

async function startServer(overrides?: {
  onRpc?: (req: JsonRpcRequest) => JsonRpcResponse
  onEvent?: (event: ExternalEvent) => void
  onHealth?: () => unknown
  onDashboardData?: () => unknown
  onDashboardEvents?: (send: (event: unknown) => void) => (() => void) | void
}) {
  // Use port 0 to let OS assign a random free port
  return new Promise<void>((resolve) => {
    server = createHttpServer({
      port: 0,
      onRpc: overrides?.onRpc ?? ((req) => ({
        jsonrpc: '2.0' as const,
        id: req.id,
        result: { echo: true },
      })),
      onEvent: overrides?.onEvent ?? (() => {}),
      onHealth: overrides?.onHealth ?? (() => ({ status: 'ok' })),
      onDashboardData: overrides?.onDashboardData ?? (() => ({ status: 'ok', tasks: [] })),
      onDashboardEvents: overrides?.onDashboardEvents,
    })
    server.on('listening', () => {
      const addr = server!.address()
      port = typeof addr === 'object' && addr ? addr.port : 0
      resolve()
    })
  })
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
})

describeIfLoopback('HTTP Server', () => {
  describe('GET /health', () => {
    it('should return health status', async () => {
      await startServer({ onHealth: () => ({ status: 'ok', agents: [] }) })
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body.status).toBe('ok')
    })
  })

  describe('GET /dashboard', () => {
    it('should return the dashboard HTML shell', async () => {
      await startServer()
      const res = await fetch(`http://127.0.0.1:${port}/dashboard`)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('wanman Dashboard')
      expect(body).toContain('Current run')
      expect(body).toContain('Agents')
      expect(body).toContain('Task Board')
      expect(body).toContain('Event History')
      expect(body).toContain('Health & Diagnostics')
      expect(body).not.toContain('Terminal Feed Reference')
    })
  })

  describe('GET /dashboard/data', () => {
    it('should return dashboard data', async () => {
      await startServer({
        onDashboardData: () => ({ port: 3120, health: { status: 'ok' }, tasks: [{ id: 't1' }] }),
      })
      const res = await fetch(`http://127.0.0.1:${port}/dashboard/data`)
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body.port).toBe(3120)
      expect((body.tasks as Array<unknown>)).toHaveLength(1)
    })
  })

  describe('GET /dashboard/events', () => {
    it('should stream dashboard events over SSE', async () => {
      await startServer({
        onDashboardEvents: (send) => {
          send({ id: 'evt-1', kind: 'loop.tick', message: 'Loop 1 started.' })
        },
      })

      const res = await fetch(`http://127.0.0.1:${port}/dashboard/events`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')

      const reader = res.body?.getReader()
      expect(reader).toBeTruthy()
      const chunk = await reader!.read()
      const text = new TextDecoder().decode(chunk.value)
      expect(text).toContain(': connected')
      expect(text).toContain('evt-1')
      await reader!.cancel()
    })
  })

  describe('POST /rpc', () => {
    it('should handle valid JSON-RPC request', async () => {
      await startServer()
      const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'test.method',
          params: { foo: 'bar' },
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body.jsonrpc).toBe('2.0')
      expect((body.result as Record<string, unknown>).echo).toBe(true)
    })

    it('should reject invalid JSON-RPC request (missing jsonrpc)', async () => {
      await startServer()
      const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 1, method: 'test' }),
      })
      expect(res.status).toBe(400)
    })

    it('should reject invalid JSON-RPC request (missing method)', async () => {
      await startServer()
      const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1 }),
      })
      expect(res.status).toBe(400)
    })

    it('should return 500 on invalid JSON body', async () => {
      await startServer()
      const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })
      expect(res.status).toBe(500)
    })
  })

  describe('POST /events', () => {
    it('should accept events', async () => {
      const receivedEvents: ExternalEvent[] = []
      await startServer({
        onEvent: (event) => { receivedEvents.push(event) },
      })

      const res = await fetch(`http://127.0.0.1:${port}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'deploy',
          source: 'github',
          payload: { repo: 'test' },
          timestamp: Date.now(),
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body.status).toBe('accepted')
      expect(receivedEvents[0]?.type).toBe('deploy')
    })
  })

  describe('Unknown routes', () => {
    it('should return 404 for unknown paths', async () => {
      await startServer()
      const res = await fetch(`http://127.0.0.1:${port}/unknown`)
      expect(res.status).toBe(404)
    })
  })
})
