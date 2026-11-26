/**
 * Message relay — routes messages between agents via MessageStore.
 *
 * When a steer message is sent, invokes a callback so the Supervisor
 * can interrupt the target agent's current Claude Code session.
 */

import type { AgentMessage, MessagePriority } from '@wanman/core';
import { MessageStore } from './message-store.js';
import { createLogger } from './logger.js';
import type { NewMessageCallback, SteerCallback } from './runtime-contracts.js';

const log = createLogger('relay');

export class Relay {
  private messageStore: MessageStore;
  private onSteer: SteerCallback | null = null;
  private onNewMessage: NewMessageCallback | null = null;

  constructor(messageStore: MessageStore) {
    this.messageStore = messageStore;
  }

  /** Register a callback for when a steer message arrives. */
  setSteerCallback(cb: SteerCallback): void {
    this.onSteer = cb;
  }

  /** Register a callback for when any message arrives (used to wake on-demand agents). */
  setNewMessageCallback(cb: NewMessageCallback): void {
    this.onNewMessage = cb;
  }

  /** Send a message. Triggers steer callback for steer, new-message callback for all. */
  send(from: string, to: string, type: string, payload: unknown, priority: MessagePriority): string {
    const id = this.messageStore.enqueue(from, to, type, payload, priority);
    log.info('send', { id, from, to, type, priority });

    if (priority === 'steer' && this.onSteer) {
      log.info('triggering steer callback', { agent: to });
      this.onSteer(to);
    } else if (this.onNewMessage) {
      this.onNewMessage(to, priority);
    }

    return id;
  }

  /** Receive pending messages for an agent. Marks them as delivered. */
  recv(agent: string, limit = 10): AgentMessage[] {
    const messages = this.messageStore.getPending(agent, limit);
    if (messages.length > 0) {
      this.messageStore.markDeliveredBatch(messages.map(m => m.id));
      log.info('recv', { agent, count: messages.length });
    }
    return messages;
  }

  restorePending(ids: string[]): void {
    this.messageStore.restorePending(ids);
  }

  /** Check if an agent has pending steer messages. */
  hasSteer(agent: string): boolean {
    return this.messageStore.hasSteer(agent);
  }

  /** Count pending (undelivered) messages for an agent. */
  countPending(agent: string): number {
    return this.messageStore.countPending(agent);
  }
}
