import { describe, expect, it, vi } from 'vitest'
import type { CronScheduler } from '../cron-scheduler.js'
import type { Relay } from '../relay.js'
import type { TaskPool } from '../task-pool.js'
import { Supervisor } from '../supervisor.js'

describe('supervisor cron delivery', () => {
  it.each(['on-demand', 'idle_cached'])('wakes an idle %s agent once and queues its next cron while busy', async lifecycle => {
    const supervisor = new Supervisor({ agents: [], dbPath: ':memory:' })
    const agent = {
      definition: { lifecycle },
      state: 'idle',
      trigger: vi.fn(async () => { agent.state = 'running' }),
      handleSteer: vi.fn(),
      stop: vi.fn(),
    }
    const { agents, cronScheduler, relay, taskPool } = supervisor as unknown as {
      agents: Map<string, typeof agent>
      cronScheduler: CronScheduler
      relay: Relay
      taskPool: TaskPool
    }
    agents.set('worker', agent)
    try {
      cronScheduler.addJob('worker', '* * * * *')
      cronScheduler.tick(new Date(2026, 1, 26, 8, 0))
      cronScheduler.tick(new Date(2026, 1, 26, 8, 1))
      expect(relay.recv('worker').map(message => [message.type, message.priority])).toEqual([
        ['cron', 'normal'], ['cron', 'normal'],
      ])
      expect(agent.trigger).toHaveBeenCalledTimes(1)
      expect(agent.handleSteer).not.toHaveBeenCalled()

      // The normal delivery policy defers idle workers with only blocked work.
      agent.state = 'idle'
      const task = { title: 'Prepare', description: '', scope: { paths: [] }, priority: 1 }
      const dependency = await taskPool.create(task)
      await taskPool.create({ ...task, title: 'Publish', assignee: 'worker', dependsOn: [dependency.id] })
      cronScheduler.tick(new Date(2026, 1, 26, 8, 2))
      expect(relay.countPending('worker')).toBe(1)
      expect(agent.trigger).toHaveBeenCalledTimes(1)
      expect(agent.handleSteer).not.toHaveBeenCalled()
    } finally {
      await supervisor.shutdown()
    }
  })
})
