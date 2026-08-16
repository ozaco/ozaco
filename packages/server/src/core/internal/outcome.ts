import { just, nothing } from 'std:result'
import type { Maybe } from 'std:result'

import type { BrokerDef } from '../types/broker'
import type { ActionSignal, Reply } from '../types/common'
import type { Outcome } from '../types/trace'

interface StoreOptions {
  readonly ttlMs: number
  readonly now?: (() => number) | undefined
}

/** TTL'd outcome records; swept lazily on every access — no background task to leak. */
export const createOutcomeStore = (options: StoreOptions): BrokerDef.OutcomeStore => {
  const now = options.now ?? Date.now
  const entries = new Map<string, Outcome>()

  const sweep = () => {
    const cutoff = now() - options.ttlMs

    for (const [cid, outcome] of entries) {
      if (outcome.ts < cutoff) {
        entries.delete(cid)
      }
    }
  }

  return {
    record(outcome: Outcome) {
      sweep()
      entries.set(outcome.cid, outcome)
    },
    get(cid: string): Maybe<Outcome> {
      sweep()
      const outcome = entries.get(cid)

      return outcome ? just(outcome) : nothing()
    },
    size: () => entries.size,
  }
}

/** TTL'd reply dedupe for `idempotencyKey` — the carrier-agnostic double-execution guard. */
export const createReplyCache = (options: StoreOptions): BrokerDef.ReplyCache => {
  const now = options.now ?? Date.now
  const entries = new Map<string, { readonly ts: number; readonly reply: Reply }>()

  const sweep = () => {
    const cutoff = now() - options.ttlMs

    for (const [key, entry] of entries) {
      if (entry.ts < cutoff) {
        entries.delete(key)
      }
    }
  }

  return {
    get(key: string) {
      sweep()

      return entries.get(key)?.reply
    },
    set(key: string, reply: Reply) {
      sweep()
      entries.set(key, { ts: now(), reply })
    },
  }
}

/** A fire-able {@link ActionSignal} — the broker fires it when the caller abandons the call. */
export const createActionSignal = (): ActionSignal & { fire(): void } => {
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
