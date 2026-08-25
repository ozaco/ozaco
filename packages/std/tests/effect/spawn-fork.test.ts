import type { Flow } from 'std:effect'
import { debounce, each, run, scoped, suspend } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { fromReadable } from '../../src/io/internal/from-readable'

// Background pumps that outlive the call that created them must be forked, not spawned: spawn is
// best-effort (a scope that never suspends again may close before the child ever runs), while fork
// guarantees the child reached its first suspension point — so its subscriptions are live and its
// try/finally teardown is armed. These tests pin that guarantee at each converted call site.

describe('debounce (forked pump)', () => {
  it('delivers a value emitted the moment the source is subscribed', async () => {
    // a source that emits synchronously on the very first pull, then completes — if the output
    // subscription were taken after the pump started, this value could be sent with no subscriber
    // listening and be dropped (signals do not buffer pre-subscription sends)
    const source: Flow<number, undefined> = {
      *[Symbol.iterator]() {
        let step = 0
        return {
          next: () => ({
            *[Symbol.iterator]() {
              step += 1
              if (step === 1) {
                return { done: false as const, value: 42 }
              }
              return { done: true as const, value: undefined }
            },
          }),
        }
      },
    }

    const outcome = await run(function* () {
      const seen: number[] = []
      for (const value of yield* each(debounce(source, 5))) {
        seen.push(value)
        yield* each.next()
      }
      return seen
    })

    expect(unwrap(outcome)).toEqual([42])
  })
})

describe('codec flow pumps (forked)', () => {
  it('decodeFlow has subscribed its source before it returns, even in a suspension-free scope', async () => {
    let subscribed = false

    const source: Flow<Uint8Array, true> = {
      *[Symbol.iterator]() {
        subscribed = true
        return {
          next: () => ({
            *[Symbol.iterator]() {
              yield* suspend()
              return { done: true as const, value: true as const }
            },
          }),
        }
      },
    }

    const outcome = await run(() =>
      scoped(function* () {
        yield* install(JsonCodec)
        yield* JsonCodec.actions.decodeFlow(source)
        // the scope closes right after this line with no further suspension — a lazily spawned
        // pump would never run: the source would stay unsubscribed and the channel close unarmed
        return subscribed
      }),
    )

    expect(unwrap(outcome)).toBe(true)
  })
})

describe('fromReadable (forked pump)', () => {
  it('releases the web reader lock even when the scope closes right after acquisition', async () => {
    let released = false
    let cancelled = false

    const reader = {
      read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
      cancel: () => {
        cancelled = true
        return Promise.resolve()
      },
      releaseLock: () => {
        released = true
      },
    }

    const outcome = await run(() =>
      scoped(function* () {
        yield* fromReadable(reader)
        // no suspension after acquiring the flow — teardown (signal.close + releaseLock in the
        // pump's finally) must already be armed for the halt to reach it
      }),
    )

    expect(unwrap(outcome)).toBeUndefined()
    expect(released).toBe(true)
    expect(cancelled).toBe(true)
  })
})
