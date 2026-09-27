/**
 * A throwing `error` hook masks the running failure WITHOUT losing it: the hook's failure is what
 * surfaces (tag, message, its own causes + the `masked: …` marker) and the masked failure is nested
 * among its causes — `appendCauses(hook, …, failure)` — so `formatFailure(f, { chain: true })`
 * still reaches the original; its causes stay on it instead of being copied onto the hook's
 * failure.
 */
import { run } from 'std:effect'
import type { Operation } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import { fail, formatFailure, isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('error hook masking keeps the cause chain', () => {
  it('the masked failure is nested among the hook failure causes', async () => {
    const original = fail('op.failed', 'the operation failed', 'op.step')
    const P = defineProtocol<unknown, { work(): Operation<void> }>({
      name: 'masked-cause',
      version: '1.0.0',
      defaults: {
        *work() {
          return yield* original
        },
      },
    })

    // the run settles to the failure the action raised
    const outcome = await run(function* () {
      yield* P.error({
        *work() {
          return yield* fail('hook.threw', 'the hook broke', 'hook.step')
        },
      })
      return yield* P.actions.work()
    })

    expect(isFailure(outcome)).toBe(true)
    if (!isFailure(outcome)) {
      return
    }

    expect(outcome.error).toBe('hook.threw')
    expect(outcome.message).toBe('the hook broke')
    expect(outcome.causes).toEqual([
      'hook.step',
      'masked: op.failed: the operation failed',
      original,
    ])
    // the original's own causes are not copied outward — they live on it, the plugin runtime
    // labels of the default and the dispatch it crossed appended in place
    expect(outcome.causes[2]).toBe(original)
    expect(original.causes).toEqual([
      'op.step',
      'work:default',
      'masked-cause@1.0.0',
      'dispatch',
      'masked-cause@1.0.0',
    ])
    expect(formatFailure(outcome, { chain: true })).toBe(
      [
        'hook.threw: the hook broke',
        '    at hook.step',
        '    at masked: op.failed: the operation failed',
        'Caused by: op.failed: the operation failed',
        '    at op.step',
        '    at work:default',
        '    at masked-cause@1.0.0',
        '    at dispatch',
        '    at masked-cause@1.0.0',
      ].join('\n'),
    )
  })

  it('a hook failure that already wraps a cause keeps its own chain and names what it masked', async () => {
    const original = fail('op.failed')
    const P = defineProtocol<unknown, { work(): Operation<void> }>({
      name: 'masked-cause-chained',
      version: '1.0.0',
      defaults: {
        *work() {
          return yield* original
        },
      },
    })
    const inner = fail('hook.dependency', 'hook dependency broke')

    const outcome = await run(function* () {
      yield* P.error({
        *work() {
          return yield* fail('hook.threw', '', inner)
        },
      })
      return yield* P.actions.work()
    })

    expect(isFailure(outcome)).toBe(true)
    if (!isFailure(outcome)) {
      return
    }
    const [own, marker, masked] = outcome.causes
    expect(own).toBe(inner)
    expect(marker).toBe('masked: op.failed')
    expect(masked).toBe(original)
  })

  it('a hook failure that wraps the failure it masks does not nest it twice', async () => {
    const original = fail('op.failed')
    const P = defineProtocol<unknown, { work(): Operation<void> }>({
      name: 'masked-cause-wrapped',
      version: '1.0.0',
      defaults: {
        *work() {
          return yield* original
        },
      },
    })

    const outcome = await run(function* () {
      yield* P.error({
        *work(failure) {
          return yield* fail('hook.threw', 'wrapped it', failure)
        },
      })
      return yield* P.actions.work()
    })

    expect(isFailure(outcome) && outcome.causes).toEqual([original, 'masked: op.failed'])
  })

  it("the hook's failure surfaces as the SAME object (a copy would be a second failure)", async () => {
    const thrown = fail('hook.threw', 'the hook broke')
    const P = defineProtocol<unknown, { work(): Operation<void> }>({
      name: 'masked-cause-identity',
      version: '1.0.0',
      defaults: {
        *work() {
          return yield* fail('op.failed')
        },
      },
    })

    const outcome = await run(function* () {
      yield* P.error({
        *work() {
          return yield* thrown
        },
      })
      return yield* P.actions.work()
    })

    expect(outcome).toBe(thrown)
    expect(thrown.causes).toEqual([
      'masked: op.failed',
      expect.objectContaining({ error: 'op.failed' }),
    ])
  })

  it('a hook rethrowing the failure it was given masks nothing', async () => {
    const original = fail('op.failed', 'the operation failed')
    const P = defineProtocol<unknown, { work(): Operation<void> }>({
      name: 'masked-cause-rethrow',
      version: '1.0.0',
      defaults: {
        *work() {
          return yield* original
        },
      },
    })

    const outcome = await run(function* () {
      yield* P.error({
        *work(error: unknown) {
          throw error
        },
      })
      return yield* P.actions.work()
    })

    expect(outcome).toBe(original)
    // no `masked: …` marker — only the labels of the default and the dispatch it crossed
    expect(original.causes).toEqual([
      'work:default',
      'masked-cause-rethrow@1.0.0',
      'dispatch',
      'masked-cause-rethrow@1.0.0',
    ])
  })
})
