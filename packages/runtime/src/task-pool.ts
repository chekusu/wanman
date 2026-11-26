/**
 * TaskPool — task lifecycle management with scope conflict detection.
 *
 * Tasks are created by the CEO agent, claimed by worker agents,
 * and tracked through their lifecycle. Scope conflict detection
 * prevents two active tasks from modifying the same files.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { TaskScopeType } from '@wanman/core';

export type TaskStatus = 'pending' | 'assigned' | 'in_progress' | 'review' | 'done' | 'failed';

export interface TaskScope {
  paths: string[];
  patterns?: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  scope: TaskScope;
  status: TaskStatus;
  assignee?: string;
  priority: number;
  createdAt: number;
  updatedAt: number;
  parentId?: string;
  dependsOn: string[];
  result?: string;
  initiativeId?: string;
  capsuleId?: string;
  subsystem?: string;
  scopeType?: TaskScopeType;
  executionProfile?: string;
}

type TaskCreateInput = Omit<Task, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'dependsOn'> & { dependsOn?: string[] };

interface TaskRow {
  id: string;
  title: string;
  description: string;
  scope: string;
  status: string;
  assignee: string | null;
  priority: number;
  created_at: number;
  updated_at: number;
  parent_id: string | null;
  depends_on: string | null;
  result: string | null;
  initiative_id: string | null;
  capsule_id: string | null;
  subsystem: string | null;
  scope_type: TaskScopeType | null;
  execution_profile: string | null;
}

const ACTIVE_STATUSES: TaskStatus[] = ['pending', 'assigned', 'in_progress', 'review'];

/**
 * Simple glob-prefix matching. Strips trailing `/**` or `/*` from a pattern
 * and checks whether the path starts with that prefix.
 */
function patternToPrefix(pattern: string): string {
  return pattern.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
}

function pathMatchesPattern(path: string, pattern: string): boolean {
  const prefix = patternToPrefix(pattern);
  return path.startsWith(prefix + '/') || path === prefix;
}

function patternsOverlap(a: string, b: string): boolean {
  const prefixA = patternToPrefix(a);
  const prefixB = patternToPrefix(b);
  // One is a prefix of the other (including equality)
  return (
    prefixA.startsWith(prefixB + '/') ||
    prefixB.startsWith(prefixA + '/') ||
    prefixA === prefixB
  );
}

function scopesOverlap(a: TaskScope, b: TaskScope): boolean {
  // 1. Exact path intersection
  for (const pathA of a.paths) {
    if (b.paths.includes(pathA)) return true;
  }

  // 2. A's patterns vs B's paths
  if (a.patterns) {
    for (const pattern of a.patterns) {
      for (const path of b.paths) {
        if (pathMatchesPattern(path, pattern)) return true;
      }
    }
  }

  // 3. B's patterns vs A's paths
  if (b.patterns) {
    for (const pattern of b.patterns) {
      for (const path of a.paths) {
        if (pathMatchesPattern(path, pattern)) return true;
      }
    }
  }

  // 4. Pattern-to-pattern overlap
  if (a.patterns && b.patterns) {
    for (const pa of a.patterns) {
      for (const pb of b.patterns) {
        if (patternsOverlap(pa, pb)) return true;
      }
    }
  }

  return false;
}

function rowToTask(row: TaskRow): Task {
  const scope = JSON.parse(row.scope) as TaskScope;
  const dependsOn: string[] = row.depends_on ? JSON.parse(row.depends_on) : [];
  const task: Task = {
    id: row.id,
    title: row.title,
    description: row.description,
    scope,
    status: row.status as TaskStatus,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dependsOn,
  };
  if (row.assignee != null) task.assignee = row.assignee;
  if (row.parent_id != null) task.parentId = row.parent_id;
  if (row.result != null) task.result = row.result;
  if (row.initiative_id != null) task.initiativeId = row.initiative_id;
  if (row.capsule_id != null) task.capsuleId = row.capsule_id;
  if (row.subsystem != null) task.subsystem = row.subsystem;
  if (row.scope_type != null) task.scopeType = row.scope_type;
  if (row.execution_profile != null) task.executionProfile = row.execution_profile;
  return task;
}

export class TaskPool {
  private db: Database.Database;
  private insertStmt!: Database.Statement;
  private getByIdStmt!: Database.Statement;
  private listAllStmt!: Database.Statement;
  private activeTasksStmt!: Database.Statement;
  private claimStmt!: Database.Statement;
  private updateStmt!: Database.Statement;
  private releaseByAssigneeStmt!: Database.Statement;

  private getByPrefixStmt!: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.init();

    this.insertStmt = this.db.prepare(`
      INSERT INTO tasks (id, title, description, scope, status, assignee, priority, created_at, updated_at, parent_id, depends_on, result, initiative_id, capsule_id, subsystem, scope_type, execution_profile)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getByIdStmt = this.db.prepare(`
      SELECT id, title, description, scope, status, assignee, priority, created_at, updated_at, parent_id, depends_on, result, initiative_id, capsule_id, subsystem, scope_type, execution_profile
      FROM tasks WHERE id = ?
    `);

    this.getByPrefixStmt = this.db.prepare(`
      SELECT id, title, description, scope, status, assignee, priority, created_at, updated_at, parent_id, depends_on, result, initiative_id, capsule_id, subsystem, scope_type, execution_profile
      FROM tasks WHERE id LIKE ? || '%'
    `);

    this.listAllStmt = this.db.prepare(`
      SELECT id, title, description, scope, status, assignee, priority, created_at, updated_at, parent_id, depends_on, result, initiative_id, capsule_id, subsystem, scope_type, execution_profile
      FROM tasks ORDER BY priority DESC, created_at ASC
    `);

    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    this.activeTasksStmt = this.db.prepare(`
      SELECT id, title, description, scope, status, assignee, priority, created_at, updated_at, parent_id, depends_on, result, initiative_id, capsule_id, subsystem, scope_type, execution_profile
      FROM tasks WHERE status IN (${placeholders})
    `);

    this.claimStmt = this.db.prepare(`
      UPDATE tasks SET status = 'assigned', assignee = ?, updated_at = ? WHERE id = ? AND status = 'pending'
    `);

    // Atomic per-field update: COALESCE keeps existing column when the bound value is NULL.
    // The trailing `? IS NULL OR status = ?` is an optional optimistic-concurrency check
    // (bind the same expectedStatus twice or NULL to disable).
    this.updateStmt = this.db.prepare(`
      UPDATE tasks SET
        status            = COALESCE(?, status),
        assignee          = COALESCE(?, assignee),
        result            = COALESCE(?, result),
        initiative_id     = COALESCE(?, initiative_id),
        capsule_id        = COALESCE(?, capsule_id),
        subsystem         = COALESCE(?, subsystem),
        scope_type        = COALESCE(?, scope_type),
        execution_profile = COALESCE(?, execution_profile),
        updated_at        = ?
      WHERE id = ?
        AND (? IS NULL OR status = ?)
    `);

    this.releaseByAssigneeStmt = this.db.prepare(`
      UPDATE tasks
      SET status = 'pending', assignee = NULL, updated_at = ?
      WHERE assignee = ? AND status IN ('assigned', 'in_progress')
    `);
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'assigned', 'in_progress', 'review', 'done', 'failed')),
        assignee TEXT,
        priority INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        parent_id TEXT,
        depends_on TEXT NOT NULL DEFAULT '[]',
        result TEXT,
        initiative_id TEXT,
        capsule_id TEXT,
        subsystem TEXT,
        scope_type TEXT CHECK(scope_type IN ('code', 'docs', 'tests', 'ops', 'mixed')),
        execution_profile TEXT
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)
    `);

    // Migration: add depends_on column if missing (existing DBs)
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'`);
    } catch {
      // Column already exists — ignore
    }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN initiative_id TEXT`);
    } catch {
      // Column already exists — ignore
    }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN capsule_id TEXT`);
    } catch {
      // Column already exists — ignore
    }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN subsystem TEXT`);
    } catch {
      // Column already exists — ignore
    }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN scope_type TEXT`);
    } catch {
      // Column already exists — ignore
    }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN execution_profile TEXT`);
    } catch {
      // Column already exists — ignore
    }
  }

  /**
   * Resolve a (possibly short) task ID to the full UUID.
   * Returns the full ID if exactly one task matches the prefix, null otherwise.
   */
  resolveId(idOrPrefix: string): string | null {
    // Fast path: full UUID (36 chars with hyphens)
    if (idOrPrefix.length === 36) return idOrPrefix;

    const rows = this.getByPrefixStmt.all(idOrPrefix) as TaskRow[];
    if (rows.length === 1) return rows[0]!.id;
    return null; // 0 matches or ambiguous
  }

  get(taskId: string): Task | null {
    // Try exact match first (fast path)
    const row = this.getByIdStmt.get(taskId) as TaskRow | undefined;
    if (row) return rowToTask(row);

    // Fallback: prefix match
    const fullId = this.resolveId(taskId);
    if (!fullId) return null;
    const prefixRow = this.getByIdStmt.get(fullId) as TaskRow | undefined;
    return prefixRow ? rowToTask(prefixRow) : null;
  }

  private insert(input: TaskCreateInput): Task {
    const id = randomUUID();
    const now = Date.now();
    const scopeJson = JSON.stringify(input.scope);
    const dependsOnJson = JSON.stringify(input.dependsOn ?? []);

    this.insertStmt.run(
      id,
      input.title,
      input.description,
      scopeJson,
      'pending',
      input.assignee ?? null,
      input.priority,
      now,
      now,
      input.parentId ?? null,
      dependsOnJson,
      input.result ?? null,
      input.initiativeId ?? null,
      input.capsuleId ?? null,
      input.subsystem ?? null,
      input.scopeType ?? null,
      input.executionProfile ?? null,
    );

    const row = this.getByIdStmt.get(id) as TaskRow;
    return rowToTask(row);
  }

  async create(input: TaskCreateInput): Promise<Task> {
    return this.insert(input);
  }

  /**
   * Admit an RPC task under the same SQLite write transaction that checks its
   * active scope. A separate read followed by await create() lets two
   * simultaneous RPCs both see an empty active set before either inserts.
   * IMMEDIATE also serializes competing supervisors sharing one database.
   * The general create() helper remains unchanged for migrations/fixtures.
   */
  createIfUnconflicted(input: TaskCreateInput): { task?: Task; conflicts: Task[] } {
    const admit = this.db.transaction(() => {
      const conflicts = this.findConflicts(input.scope);
      if (conflicts.length > 0) return { conflicts };
      return { task: this.insert(input), conflicts: [] };
    });
    return admit.immediate();
  }

  async claim(taskId: string, agentId: string): Promise<Task> {
    const fullId = this.resolveId(taskId) ?? taskId;
    const now = Date.now();
    const result = this.claimStmt.run(agentId, now, fullId);

    if (result.changes === 0) {
      const row = this.getByIdStmt.get(fullId) as TaskRow | undefined;
      if (!row) {
        throw new Error(`Task not found: ${taskId}`);
      }
      throw new Error(`Task ${taskId} cannot be claimed (status: ${row.status})`);
    }

    const updated = this.getByIdStmt.get(fullId) as TaskRow;
    return rowToTask(updated);
  }

  async update(
    taskId: string,
    updates: Partial<Pick<Task, 'status' | 'assignee' | 'result' | 'initiativeId' | 'capsuleId' | 'subsystem' | 'scopeType' | 'executionProfile'>>,
    expectedStatus?: TaskStatus,
  ): Promise<Task> {
    const fullId = this.resolveId(taskId) ?? taskId;
    const now = Date.now();
    const expected = expectedStatus ?? null;

    const result = this.updateStmt.run(
      updates.status ?? null,
      updates.assignee ?? null,
      updates.result ?? null,
      updates.initiativeId ?? null,
      updates.capsuleId ?? null,
      updates.subsystem ?? null,
      updates.scopeType ?? null,
      updates.executionProfile ?? null,
      now,
      fullId,
      expected,
      expected,
    );

    if (result.changes === 0) {
      const row = this.getByIdStmt.get(fullId) as TaskRow | undefined;
      if (!row) {
        throw new Error(`Task not found: ${taskId}`);
      }
      if (expectedStatus) {
        throw new Error(`Task ${taskId} update conflict: expected status ${expectedStatus}, got ${row.status}`);
      }
    }

    const updated = this.getByIdStmt.get(fullId) as TaskRow;
    return rowToTask(updated);
  }

  /**
   * Revert claimed tasks back to 'pending' when their agent dies.
   * Tasks in 'review' / 'done' / 'failed' are left alone.
   * Returns the number of tasks released.
   */
  releaseByAssignee(agentId: string): number {
    const result = this.releaseByAssigneeStmt.run(Date.now(), agentId);
    return result.changes;
  }

  /** Sync version of list() — for use in non-async contexts. */
  listSync(): Task[] {
    const rows = this.listAllStmt.all() as TaskRow[];
    return rows.map(rowToTask);
  }

  async list(filter?: { status?: TaskStatus; assignee?: string }): Promise<Task[]> {
    if (!filter || (!filter.status && !filter.assignee)) {
      const rows = this.listAllStmt.all() as TaskRow[];
      return rows.map(rowToTask);
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter.assignee) {
      conditions.push('assignee = ?');
      params.push(filter.assignee);
    }

    const where = conditions.join(' AND ');
    const stmt = this.db.prepare(`
      SELECT id, title, description, scope, status, assignee, priority, created_at, updated_at, parent_id, depends_on, result, initiative_id, capsule_id, subsystem, scope_type, execution_profile
      FROM tasks WHERE ${where} ORDER BY priority DESC, created_at ASC
    `);

    const rows = stmt.all(...params) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Check if all dependsOn tasks for the given task are done. */
  areDependenciesMet(taskId: string): boolean {
    const task = this.get(taskId);
    if (!task || task.dependsOn.length === 0) return true;
    for (const depId of task.dependsOn) {
      const dep = this.get(depId);
      if (!dep || dep.status !== 'done') return false;
    }
    return true;
  }

  private findConflicts(scope: TaskScope, excludeTaskId?: string): Task[] {
    const rows = this.activeTasksStmt.all(...ACTIVE_STATUSES) as TaskRow[];
    const conflicts: Task[] = [];

    for (const row of rows) {
      if (excludeTaskId && row.id === excludeTaskId) continue;

      const taskScope = JSON.parse(row.scope) as TaskScope;
      if (scopesOverlap(scope, taskScope)) {
        conflicts.push(rowToTask(row));
      }
    }

    return conflicts;
  }

  async checkConflict(scope: TaskScope, excludeTaskId?: string): Promise<Task[]> {
    return this.findConflicts(scope, excludeTaskId);
  }
}
