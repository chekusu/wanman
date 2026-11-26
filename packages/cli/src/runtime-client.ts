export interface TaskInfo {
  id: string
  title: string
  status: string
  assignee?: string
  priority: number
  result?: string
  initiativeId?: string
  capsuleId?: string
}

export interface HealthAgent {
  name: string
  state: string
  lifecycle: string
}

export interface RuntimeHealth {
  agents: HealthAgent[]
  loop?: { runId?: string; currentLoop?: number }
  runtime?: {
    completedRuns?: number
    completedRunsByAgent?: Record<string, number>
    initiatives?: number
    activeInitiatives?: number
    capsules?: number
    activeCapsules?: number
  }
}

export interface RuntimeInitiative {
  id: string
  title?: string
  priority?: number
  status: string
}

export interface RuntimeCapsule {
  id: string
  goal?: string
  status: string
  ownerAgent?: string
  branch?: string
  initiativeId?: string
  taskId?: string
}

export interface RuntimeArtifact {
  agent: string
  kind: string
  cnt: number
}

interface RuntimeArtifactRecord {
  agent: string
  kind: string
  cnt?: number
}

export interface RuntimeClient {
  waitForHealth(timeoutMs?: number): Promise<void>
  getHealth(): Promise<RuntimeHealth>
  listTasks(): Promise<TaskInfo[]>
  listInitiatives(): Promise<RuntimeInitiative[]>
  listCapsules(): Promise<RuntimeCapsule[]>
  listArtifacts(): Promise<RuntimeArtifact[]>
  createInitiative(input: {
    title: string
    goal: string
    summary: string
    priority: number
    sources: string[]
    status?: string
    agent?: string
  }): Promise<void>
  sendMessage(input: {
    from: string
    to: string
    payload: string
    priority?: 'normal' | 'steer'
    type?: 'message'
  }): Promise<void>
  spawnAgent(template: string, name: string): Promise<void>
  updateTask(input: {
    id: string
    assignee?: string
    status?: string
    agent?: string
  }): Promise<void>
}

function summarizeArtifacts(artifacts: RuntimeArtifactRecord[]): RuntimeArtifact[] {
  const counts = new Map<string, RuntimeArtifact>()
  for (const artifact of artifacts) {
    const key = `${artifact.agent}:${artifact.kind}`
    const current = counts.get(key)
    if (current) current.cnt += artifact.cnt ?? 1
    else counts.set(key, { agent: artifact.agent, kind: artifact.kind, cnt: artifact.cnt ?? 1 })
  }
  return [...counts.values()].sort((a, b) => `${a.agent}:${a.kind}`.localeCompare(`${b.agent}:${b.kind}`))
}

async function waitForHealthWith(getHealth: () => Promise<RuntimeHealth>, timeoutMs = 120_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      await getHealth()
      return
    } catch {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`Supervisor not healthy within ${timeoutMs}ms`)
}

async function localRpc<T>(port: number, method: string, params: Record<string, unknown>): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!response.ok) {
    throw new Error(`RPC ${method} failed with status ${response.status}`)
  }
  const body = await response.json() as { error?: { message?: string }; result?: T }
  if (body.error) throw new Error(body.error.message || `RPC ${method} failed`)
  return body.result as T
}

export function createLocalRuntimeClient(port: number): RuntimeClient {
  const getHealth = async (): Promise<RuntimeHealth> => {
    const response = await fetch(`http://127.0.0.1:${port}/health`)
    if (!response.ok) throw new Error(`Health failed with status ${response.status}`)
    return await response.json() as RuntimeHealth
  }

  return {
    waitForHealth: timeoutMs => waitForHealthWith(getHealth, timeoutMs),
    getHealth,
    listTasks: async () => {
      const result = await localRpc<{ tasks: TaskInfo[] }>(port, 'task.list', {})
      return result.tasks
    },
    listInitiatives: async () => {
      const result = await localRpc<{ initiatives: RuntimeInitiative[] }>(port, 'initiative.list', {})
      return result.initiatives
    },
    listCapsules: async () => {
      const result = await localRpc<{ capsules: RuntimeCapsule[] }>(port, 'capsule.list', {})
      return result.capsules
    },
    listArtifacts: async () => {
      const result = await localRpc<RuntimeArtifactRecord[] | { artifacts: RuntimeArtifactRecord[] }>(port, 'artifact.list', {})
      return summarizeArtifacts(Array.isArray(result) ? result : result.artifacts)
    },
    createInitiative: async input => {
      await localRpc(port, 'initiative.create', input)
    },
    sendMessage: async input => {
      await localRpc(port, 'agent.send', input)
    },
    spawnAgent: async (template, name) => {
      await localRpc(port, 'agent.spawn', { template, name })
    },
    updateTask: async input => {
      await localRpc(port, 'task.update', input)
    },
  }
}
