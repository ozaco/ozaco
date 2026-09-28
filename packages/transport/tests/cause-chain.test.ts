/**
 * A codec `Error` thrown under the `transport.encoding` rewrap sits ONE level under the tag, as
 * its fold (`std:result.unknown`, the Error its `raw`): the chain is two levels
 * (`transport.encoding → std:result.unknown`), never three, exactly like the backends' client
 * errors. A failure leaving a transport action (`publish`) then carries the labels std's plugin
 * runtime appends, inner hop first, as string causes of the outer level; a subscription's
 * `next()` crosses no action, so it carries none.
 */
import { Codec } from 'std:codec'
import { attempt, run } from 'std:effect'
import type { Result } from 'std:result'
import { formatFailure, isFailure, ResultErrors, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'
import { Transport, TransportErrors } from 'transport:core'
import { createLink, MemoryTransport } from 'transport:impl/memory'

import pkg from '../package.json'

const link = createLink()

/** The labels std's plugin runtime appends to a failure leaving `Transport.actions.publish`:
 * the memory impl's action, then the protocol's dispatch. */
const PUBLISH_LABELS = [
  'publish',
  `transport-memory@${pkg.version}`,
  'dispatch',
  `transport@${pkg.version}`,
]

/** The failure a rewrap produced, checked two levels deep: `tag → the thrown Error's fold`, the
 * fold followed by exactly `labels`. */
const expectTwoLevels = (outcome: unknown, thrown: Error, labels: readonly string[]): void => {
  expect(isFailure(outcome)).toBe(true)

  const failure = outcome as Result.Failure<unknown>

  expect(failure.error).toBe(TransportErrors.Encoding)
  expect(failure.causes).toHaveLength(1 + labels.length)

  const [nested, ...rest] = failure.causes

  expect(rest).toEqual([...labels])
  expect(isFailure(nested)).toBe(true)

  const level = nested as Result.Failure<unknown>

  // the fold of the Error — the Error itself is its `raw`, no level of its own
  expect(level.error).toBe(ResultErrors.Unknown)
  expect(level.message).toBe(`${thrown.name}: ${thrown.message}`)
  expect(level.raw).toBe(thrown)
  expect(level.causes).toEqual([])
}

describe('cause chain: a thrown codec Error nests one level under transport.encoding', () => {
  it('publish: a throwing codec fails transport.encoding → the fold of the Error', async () => {
    const boom = new RangeError('encode boom')
    const { outcome } = unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* MemoryTransport.use({ prefix: 'chain-out', link })
        yield* Codec.around({
          *encode() {
            throw boom
          },
        })

        // a Failure returned from `run` would be raised: hand it back inside an object
        return { outcome: yield* attempt(Transport.actions.publish('t', { n: 1 })) }
      }),
    )

    expectTwoLevels(outcome, boom, PUBLISH_LABELS)
    expect(formatFailure(outcome as Result.Failure<unknown>)).toBe(
      `transport.encoding: cannot encode value: (std:result.unknown: RangeError: encode boom) > ${PUBLISH_LABELS.join(' > ')}`,
    )
  })

  it('subscribe: a throwing codec fails transport.encoding → the fold of the Error', async () => {
    const boom = new SyntaxError('decode boom')
    const { outcome } = unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* MemoryTransport.use({ prefix: 'chain-in', link })

        const subscription = yield* Transport.actions.subscribe<{ n: number }>('t')

        yield* Transport.actions.publish('t', { n: 1 })
        yield* Codec.around({
          *decode() {
            throw boom
          },
        })

        return { outcome: yield* attempt(subscription.next()) }
      }),
    )

    expectTwoLevels(outcome, boom, [])
  })
})
