import { current, span } from 'std:trace'

/**
 * The trace clock is ONE sub-millisecond time line per process (`performance.timeOrigin` against
 * the monotonic clock): a local root opened under another local root's span — a node answering a
 * call from another node of the same process — never starts before the span that called it. A
 * per-root `Date.now()` anchor was cut to whole milliseconds, so a later root could read up to 1 ms
 * early. The anchor is taken anew only when it drifted from the wall clock (a suspended machine).
 */
import { afterEach, describe, expect, it } from 'bun:test'

import { anchorNow, timeOf } from '../../src/trace/internal/clock'

import { traced } from './helpers'

/** Spin for up to one millisecond, so roots land at every sub-millisecond offset. */
const spin = (ms: number) => {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // busy
  }
}

const realNow = Date.now

afterEach(() => {
  Date.now = realNow
})

describe('trace clock', () => {
  it('a local root under a span of another local root never starts before it', async () => {
    const { tracer } = await traced(function* () {
      for (let at = 0; at < 200; at += 1) {
        yield* span(`caller ${at}`, { parent: null }, function* () {
          spin(Math.random())
          yield* span(`call ${at}`, { kind: 'client' }, function* () {
            const context = (yield* current()).context
            spin(Math.random() / 4)
            // the other node's side: under a span of its own, the call's context is a REMOTE
            // parent — a new local root, anchoring its own clock
            yield* span(`hop ${at}`, function* () {
              yield* span(`serve ${at}`, { kind: 'server', parent: context }, function* () {})
            })
          })
        })
      }
    })

    const early: string[] = []
    for (let at = 0; at < 200; at += 1) {
      const call = tracer.span(`call ${at}`)
      const serve = tracer.span(`serve ${at}`)
      expect(serve.parent?.spanId).toBe(call.context.spanId)
      // a local root of its own (its parent is not the span active where it opened)
      expect(serve.parent?.spanId).not.toBe(tracer.span(`hop ${at}`).context.spanId)
      if (serve.start < call.start) {
        early.push(`${at}: ${(call.start - serve.start).toFixed(3)} ms early`)
      }
    }

    expect(early).toEqual([])
  })

  it('reads the wall clock to a fraction of a millisecond, one anchor for the process', () => {
    const first = anchorNow()

    expect(anchorNow()).toBe(first)
    expect(Math.abs(timeOf(first) - Date.now())).toBeLessThanOrEqual(2)
    expect(first.wall).toBe(performance.timeOrigin)
  })

  it('anchors anew when the wall clock moved away from it (a suspended machine)', () => {
    const before = anchorNow()
    const jump = 3_600_000
    Date.now = () => realNow() + jump

    const after = anchorNow()

    expect(after).not.toBe(before)
    expect(Math.abs(timeOf(after) - (realNow() + jump))).toBeLessThanOrEqual(2)

    // back to the real clock: the process anchor again
    Date.now = realNow
    expect(anchorNow()).toBe(before)
    expect(before.wall).toBe(performance.timeOrigin)
  })
})
