// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Composer message queue: what the user submits while a reply is streaming.
 * Pure operations only — Chat.tsx owns the state, the queue panel renders it.
 * The queue is ephemeral client state (not persisted); a page reload clears it.
 */

export interface QueuedMessage {
  id: string;
  text: string;
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `q-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Append a message to the end of the queue (FIFO drain). */
export function enqueueMessage(queue: QueuedMessage[], text: string): QueuedMessage[] {
  const trimmed = text.trim();
  if (!trimmed) return queue;
  return [...queue, { id: newId(), text: trimmed }];
}

/** Drop the message with this id. */
export function removeQueued(queue: QueuedMessage[], id: string): QueuedMessage[] {
  return queue.filter((m) => m.id !== id);
}

/** Move an item to another position (drag reorder). No-op for bad indexes. */
export function moveQueued(queue: QueuedMessage[], from: number, to: number): QueuedMessage[] {
  if (from === to) return queue;
  if (from < 0 || to < 0 || from >= queue.length || to >= queue.length) return queue;
  const next = [...queue];
  const [item] = next.splice(from, 1);
  if (!item) return queue;
  next.splice(to, 0, item);
  return next;
}

/**
 * Take the next message to send: the forced one ("send now" — jumps the
 * queue) or the head. Returns null when the queue is empty; a missing
 * forced id falls back to the head.
 */
export function takeNextQueued(
  queue: QueuedMessage[],
  forcedId?: string | null
): { item: QueuedMessage; rest: QueuedMessage[] } | null {
  if (queue.length === 0) return null;
  let index = 0;
  if (forcedId) {
    const found = queue.findIndex((m) => m.id === forcedId);
    if (found >= 0) index = found;
  }
  const item = queue[index];
  if (!item) return null;
  return { item, rest: queue.filter((m) => m.id !== item.id) };
}
