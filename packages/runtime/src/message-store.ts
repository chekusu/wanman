/**
 * SQLite-backed message store.
 * Messages are enqueued with a priority (steer | normal).
 * getPending returns steer messages first (sorted by timestamp).
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { AgentMessage, MessagePriority } from '@wanman/core';
import { createLogger } from './logger.js';

const log = createLogger('message-store');

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

export class MessageStore {
  private db: Database.Database;
  private insertStmt!: Database.Statement;
  private pendingStmt!: Database.Statement;
  private deliverStmt!: Database.Statement;
  private hasSteerStmt!: Database.Statement;
  private countPendingStmt!: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.init();

    this.insertStmt = this.db.prepare(`
      INSERT INTO messages (id, "from", "to", priority, type, payload, timestamp, delivered)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `);

    // steer first (priority ordering: steer=0, normal=1), then by timestamp
    this.pendingStmt = this.db.prepare(`
      SELECT id, "from", "to", priority, type, payload, timestamp, delivered
      FROM messages
      WHERE "to" = ? AND delivered = 0
      ORDER BY CASE priority WHEN 'steer' THEN 0 ELSE 1 END, timestamp ASC
      LIMIT ?
    `);

    this.deliverStmt = this.db.prepare(`
      UPDATE messages SET delivered = 1 WHERE id = ?
    `);

    this.hasSteerStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE "to" = ? AND delivered = 0 AND priority = 'steer'
    `);

    this.countPendingStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE "to" = ? AND delivered = 0
    `);
  }

  private init(): void {
    // Check if table exists and needs migration (old content column → type + payload)
    const tableInfo = this.db.pragma('table_info(messages)') as Array<{ name: string }>;
    const hasContent = tableInfo.some(c => c.name === 'content');
    const hasType = tableInfo.some(c => c.name === 'type');

    if (hasContent && !hasType) {
      // Old schema detected — migrate
      log.info('migrating messages table: content → type + payload');
      this.db.exec(`ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'message'`);
      this.db.exec(`ALTER TABLE messages RENAME COLUMN content TO payload`);
      this.db.exec(`UPDATE messages SET priority = 'normal' WHERE priority = 'followUp'`);
    } else if (tableInfo.length === 0) {
      // No table yet — create with new schema
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          "from" TEXT NOT NULL,
          "to" TEXT NOT NULL,
          priority TEXT NOT NULL CHECK(priority IN ('steer', 'normal')),
          type TEXT NOT NULL DEFAULT 'message',
          payload TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          delivered INTEGER NOT NULL DEFAULT 0
        )
      `);
    }
    // else: already new schema, nothing to do

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_to_delivered
      ON messages("to", delivered)
    `);
    log.info('initialized');
  }

  /** Enqueue a message. Returns the message ID. */
  enqueue(from: string, to: string, type: string, payload: unknown, priority: MessagePriority): string {
    const id = randomUUID();
    const timestamp = Date.now();
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.insertStmt.run(id, from, to, priority, type, payloadStr, timestamp);
    log.info('enqueued', { id, from, to, type, priority });
    return id;
  }

  /** Get pending messages for an agent. Steer messages come first. */
  getPending(agent: string, limit = 10): AgentMessage[] {
    const rows = this.pendingStmt.all(agent, limit) as Array<{
      id: string; from: string; to: string; priority: MessagePriority;
      type: string; payload: string; timestamp: number; delivered: number;
    }>;
    return rows.map(r => ({
      id: r.id,
      from: r.from,
      to: r.to,
      type: r.type,
      payload: tryParseJson(r.payload),
      priority: r.priority,
      timestamp: r.timestamp,
      delivered: Boolean(r.delivered),
    }));
  }

  /** Undo delivery of a batch that failed before the runtime handed it to a child. */
  restorePending(ids: string[]): void {
    const restore = this.db.prepare('UPDATE messages SET delivered = 0 WHERE id = ?');
    this.db.transaction(() => {
      for (const id of ids) restore.run(id);
    })();
  }

  /** Mark a message as delivered. */
  markDelivered(id: string): void {
    this.deliverStmt.run(id);
  }

  /** Mark multiple messages as delivered (in a transaction). */
  markDeliveredBatch(ids: string[]): void {
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        this.deliverStmt.run(id);
      }
    });
    tx();
  }

  /** Check if an agent has any pending steer messages. */
  hasSteer(agent: string): boolean {
    const row = this.hasSteerStmt.get(agent) as { count: number } | undefined;
    return (row?.count ?? 0) > 0;
  }

  /** Count pending (undelivered) messages for an agent. */
  countPending(agent: string): number {
    const row = this.countPendingStmt.get(agent) as { count: number } | undefined;
    return row?.count ?? 0;
  }
}
