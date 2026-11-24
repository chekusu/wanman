import type { AgentMessage, ContextEntry, MessagePriority } from '@wanman/core';

export type MaybePromise<T> = T | Promise<T>;

export type SteerCallback = (agentName: string) => void;
export type NewMessageCallback = (agentName: string, priority: MessagePriority) => void;

export interface MessageTransport {
  send(from: string, to: string, type: string, payload: unknown, priority: MessagePriority): string;
  recv(agent: string, limit?: number): MaybePromise<AgentMessage[]>;
  /** Return an undelivered startup batch to its original position when no process was started. */
  restorePending?(ids: string[]): MaybePromise<void>;
  hasSteer(agent: string): boolean;
  countPending(agent: string): number;
  setSteerCallback(cb: SteerCallback): void;
  setNewMessageCallback(cb: NewMessageCallback): void;
}

export interface ContextBackend {
  get(key: string): MaybePromise<ContextEntry | null>;
  set(key: string, value: string, agent: string): MaybePromise<void>;
  getAll(): MaybePromise<ContextEntry[]>;
}

export async function resolveMaybePromise<T>(value: MaybePromise<T>): Promise<T> {
  return await value;
}
