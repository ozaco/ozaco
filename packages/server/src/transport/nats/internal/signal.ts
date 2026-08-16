import type { ActionSignal } from 'server:core'

export interface RemoteSignal extends ActionSignal {
  fire(): void
}

/**
 * A fire-able {@link ActionSignal} for the OWNER side: the caller's abandonment arrives as a
 * `cancel` envelope, and firing this lets `detach`-minded handlers observe it via `useSignal()`
 * exactly like a local dispatch would.
 */
export const createRemoteSignal = (): RemoteSignal => {
  const listeners = new Set<() => void>()
  let aborted = false

  return {
    aborted: () => aborted,
    onAbort(listener: () => void) {
      if (aborted) {
        listener()

        return () => {}
      }

      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    fire() {
      if (aborted) {
        return
      }

      aborted = true

      for (const listener of listeners) {
        listener()
      }

      listeners.clear()
    },
  }
}
