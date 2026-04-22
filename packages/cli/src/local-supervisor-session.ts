import type { ChildProcess } from 'node:child_process'
import { startLocalSupervisor, type LocalSupervisorHandle, type LocalSupervisorOptions } from './local-supervisor.js'
import type { RuntimeClient } from './runtime-client.js'

export type LocalSupervisorSessionReason = 'completed' | 'error' | 'signal'
export type LocalSupervisorSignalMode = 'forward_only' | 'exit_process'

export interface LocalSupervisorSessionContext {
  supervisor: LocalSupervisorHandle
  runtime: RuntimeClient
  child: ChildProcess
  port: number
  endpoint: string
  entrypoint: string
  isShuttingDown(): boolean
}

export interface RunLocalSupervisorSessionParams {
  supervisor: LocalSupervisorOptions
  keep?: boolean
  signalMode?: LocalSupervisorSignalMode
  onStarted?(context: LocalSupervisorSessionContext): Promise<void> | void
  onHealthy?(context: LocalSupervisorSessionContext): Promise<void> | void
  onSignal?(context: LocalSupervisorSessionContext): Promise<void> | void
  onError?(error: unknown, context: LocalSupervisorSessionContext): Promise<void> | void
  onStopped?(context: LocalSupervisorSessionContext, reason: LocalSupervisorSessionReason): Promise<void> | void
  onKeptAlive?(context: LocalSupervisorSessionContext, reason: LocalSupervisorSessionReason): Promise<void> | void
  run(context: LocalSupervisorSessionContext): Promise<void>
}

async function waitForEarlyExit(supervisor: LocalSupervisorHandle): Promise<never> {
  const code = await new Promise<number | null>((resolve, reject) => {
    supervisor.child.once('error', reject)
    supervisor.child.once('close', resolve)
  })
  const logs = await supervisor.readLogs(0).catch(() => ({ lines: [] as string[], cursor: 0 }))
  const tail = logs.lines.slice(-20)
  const details = tail.length > 0 ? `\n\nSupervisor logs:\n${tail.join('\n')}` : ''
  throw new Error(`Supervisor exited before becoming healthy with code ${code ?? 'unknown'}.${details}`)
}

export async function runLocalSupervisorSession(params: RunLocalSupervisorSessionParams): Promise<void> {
  const supervisor = await startLocalSupervisor(params.supervisor)
  const detachSignalForwarding = supervisor.attachSignalForwarding()
  let shuttingDown = false
  let disposed = false

  const context: LocalSupervisorSessionContext = {
    supervisor,
    runtime: supervisor.runtime,
    child: supervisor.child,
    port: supervisor.port,
    endpoint: supervisor.endpoint,
    entrypoint: supervisor.entrypoint ?? '',
    isShuttingDown: () => shuttingDown,
  }

  let exitReason: LocalSupervisorSessionReason = 'completed'
  const signalMode = params.signalMode ?? 'forward_only'

  const dispose = async (reason: LocalSupervisorSessionReason) => {
    if (disposed) return
    disposed = true

    process.off('SIGINT', handleSignal)
    process.off('SIGTERM', handleSignal)
    detachSignalForwarding()

    if (!params.keep) {
      await supervisor.stop().catch(() => undefined)
      await supervisor.waitForExit().catch(() => undefined)
      await params.onStopped?.(context, reason)
      return
    }

    await params.onKeptAlive?.(context, reason)
  }

  const handleSignal = async () => {
    if (shuttingDown) return
    shuttingDown = true
    exitReason = 'signal'
    await params.onSignal?.(context)
    await dispose('signal')
    if (signalMode === 'exit_process') process.exit(0)
  }

  if (signalMode === 'exit_process') {
    process.on('SIGINT', handleSignal)
    process.on('SIGTERM', handleSignal)
  }

  try {
    await params.onStarted?.(context)
    await Promise.race([
      context.runtime.waitForHealth(),
      waitForEarlyExit(supervisor),
    ])
    await params.onHealthy?.(context)
    await params.run(context)
  } catch (error) {
    exitReason = 'error'
    if (params.onError) {
      await params.onError(error, context)
    } else {
      throw error
    }
  } finally {
    if (!shuttingDown) {
      await dispose(exitReason)
    }
  }
}
