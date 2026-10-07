/**
 * Minimal reactive store. One value, synchronous updates, subscription list.
 * This is the entire state layer; there is no framework.
 */

export interface Store<T> {
  get(): T
  /** Merge a partial object or apply an updater to the current value. */
  set(updater: Partial<T> | ((current: T) => T)): void
  /** Returns an unsubscribe function. */
  subscribe(listener: (value: T) => void): () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let value: T = initial
  const listeners = new Set<(value: T) => void>()

  return {
    get: () => value,

    set(updater) {
      value =
        typeof updater === 'function'
          ? (updater as (current: T) => T)(value)
          : { ...value, ...updater }
      for (const listener of Array.from(listeners)) listener(value)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
