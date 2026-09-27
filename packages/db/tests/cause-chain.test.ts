/**
 * A platform `Error` thrown under a `kv.*` / `db.*` rewrap — a codec, an id minter, the IO impl,
 * an adapter — sits ONE level under the tag, as the runtime's fold of it (`std:result.unknown`,
 * the Error kept as its `raw`): the chain is two levels (`kv.encoding → std:result.unknown`),
 * never a third level for the Error itself. The plugin runtime's labels follow the nested fold on
 * the tag level, inner hop first: the action and its impl, then `dispatch` and the protocol
 * (`setup` and the plugin for an install).
 */
import { DbAdapter, DbClient, DbErrors, Kv, KvErrors } from 'db:core'
import { Codec } from 'std:codec'
import { attempt, run } from 'std:effect'
import { IO } from 'std:io'
import type { Result } from 'std:result'
import { formatFailure, isFailure, ResultErrors, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'
import { MemoryKv } from 'db:impl/memory-kv'
import { TableKv } from 'db:impl/table-kv'
import { BunIO } from 'std:io/impl/bun'

import pkg from '../package.json'

import { users } from './helpers'

/** The failure a rewrap produced, checked two levels deep: `tag → the fold of the thrown Error`,
 * the runtime's `labels` after the fold on the tag level. */
const expectTwoLevels = (
  outcome: unknown,
  thrown: Error,
  { tag, labels }: { readonly tag: string; readonly labels: readonly string[] },
): void => {
  expect(isFailure(outcome)).toBe(true)
  const failure = outcome as Result.Failure<unknown>
  expect(failure.error).toBe(tag)
  expect(failure.causes).toHaveLength(1 + labels.length)
  const [nested, ...rest] = failure.causes
  expect(rest).toEqual([...labels])
  expect(isFailure(nested)).toBe(true)
  const level = nested as Result.Failure<unknown>
  // the runtime's fold of the Error — the Error itself its `raw`, nothing under it; no labels
  // either: the rewrap folded it before a runtime guard saw it, the guards label the rewrap
  expect(level.error).toBe(ResultErrors.Unknown)
  expect(level.raw).toBe(thrown)
  expect(level.message).toBe(`${thrown.name}: ${thrown.message}`)
  expect(level.causes).toEqual([])
}

describe('cause chain: a thrown platform Error nests one level under its tag', () => {
  it('Kv set: a throwing codec fails kv.encoding → the fold of the Error', async () => {
    const boom = new RangeError('encode boom')
    const { outcome } = unwrap(
      await run(function* () {
        yield* MemoryKv.use({ prefix: 'chain-set' })
        yield* Codec.around({
          *encode() {
            throw boom
          },
        })
        return { outcome: yield* attempt(Kv.actions.set('k', { n: 1 })) }
      }),
    )

    expectTwoLevels(outcome, boom, {
      tag: KvErrors.Encoding,
      labels: ['set', MemoryKv.tag, 'dispatch', Kv.tag],
    })
    expect(formatFailure(outcome as Result.Failure<unknown>)).toBe(
      'kv.encoding: cannot encode value: (std:result.unknown: RangeError: encode boom) > set > ' +
        `kv-memory@${pkg.version} > dispatch > kv@${pkg.version}`,
    )
  })

  it('Kv get: a throwing codec fails kv.encoding → the fold of the Error', async () => {
    const boom = new SyntaxError('decode boom')
    const { outcome } = unwrap(
      await run(function* () {
        yield* MemoryKv.use({ prefix: 'chain-get' })
        yield* Kv.actions.set('k', { n: 1 })
        yield* Codec.around({
          *decode() {
            throw boom
          },
        })
        return { outcome: yield* attempt(Kv.actions.get('k')) }
      }),
    )

    expectTwoLevels(outcome, boom, {
      tag: KvErrors.Encoding,
      labels: ['get', MemoryKv.tag, 'dispatch', Kv.tag],
    })
  })

  it('DbClient: a throwing id minter fails db.configuration → the fold of the Error', async () => {
    const boom = new RangeError('no entropy')
    const { outcome } = unwrap(
      await run(function* () {
        yield* MemoryAdapter.use()
        yield* BunIO.use()
        const installed = yield* attempt(
          DbClient.use({
            tables: [users],
            *id() {
              throw boom
            },
          }),
        )
        // a Failure returned from `run` would be raised: hand it back inside an object
        return { outcome: installed }
      }),
    )

    expectTwoLevels(outcome, boom, {
      tag: DbErrors.Configuration,
      labels: ['setup', DbClient.tag],
    })
  })

  it('DbClient: an IO impl whose hlc throws fails db.configuration → the fold of the Error', async () => {
    const boom = new TypeError('clock unavailable')
    const { outcome } = unwrap(
      await run(function* () {
        yield* MemoryAdapter.use()
        yield* BunIO.use()
        yield* IO.around({
          *hlc() {
            throw boom
          },
        })
        return { outcome: yield* attempt(DbClient.use({ tables: [users] })) }
      }),
    )

    expectTwoLevels(outcome, boom, {
      tag: DbErrors.Configuration,
      labels: ['setup', DbClient.tag],
    })
  })

  it('TableKv: an adapter whose migrate throws fails kv.configuration → the fold of the Error', async () => {
    const boom = new Error('disk full')
    const { outcome } = unwrap(
      await run(function* () {
        yield* MemoryAdapter.use()
        yield* DbAdapter.around({
          *migrate() {
            throw boom
          },
        })
        return { outcome: yield* attempt(TableKv.use({ prefix: 'chain-table' })) }
      }),
    )

    expectTwoLevels(outcome, boom, {
      tag: KvErrors.Configuration,
      labels: ['setup', TableKv.tag],
    })
  })

  it('a tagged failure under the same rewrap is nested as is', async () => {
    const { outcome } = unwrap(
      await run(function* () {
        yield* MemoryAdapter.use()
        yield* BunIO.use()
        return { outcome: yield* attempt(DbClient.use({ tables: [users], origin: 'NODE-A' })) }
      }),
    )

    expect(isFailure(outcome)).toBe(true)
    const failure = outcome as Result.Failure<unknown>
    expect(failure.error).toBe(DbErrors.Configuration)
    expect(failure.causes).toHaveLength(3)
    const [nested, ...labels] = failure.causes
    // the IO failure is nested with the labels of its own hop (the impl's `hlc`, the dispatch)
    const io = nested as Result.Failure<unknown>
    expect(io.error).toBe('std:io.hlc-invalid')
    expect(io.causes).toEqual(['hlc', BunIO.tag, 'dispatch', IO.tag])
    // the install's labels on the rewrap
    expect(labels).toEqual(['setup', DbClient.tag])
  })
})
