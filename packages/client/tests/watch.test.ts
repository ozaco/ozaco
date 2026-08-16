import { createClient } from 'client:core'
import { run, until } from 'std:effect'
import type { Result } from 'std:result'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import type { Api } from './helpers'
import { bootClientEnv, bootServer, deferred, withTimeout } from './helpers'

interface Row {
  readonly _id: string
  readonly title: string
}

describe('client watch', () => {
  it('streams list rows: initial sync, then rows materialized from deltas', async () => {
    const result = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* bootClientEnv()

        const client = yield* createClient<Api>({ url: info.url })

        yield* client.tasks.create({ title: 'first' })
        yield* client.tasks.create({ title: 'second' })

        const frames: { rows: readonly unknown[]; version: number }[] = []
        const first = deferred<readonly unknown[]>()
        const second = deferred<readonly unknown[]>()

        const stop = yield* client.tasks.list.watch({}, (rows, version) => {
          frames.push({ rows, version })

          if (frames.length === 1) {
            first.resolve(rows)
          }

          if (frames.length === 2) {
            second.resolve(rows)
          }
        })

        const initial = yield* until(withTimeout(first.promise))

        yield* client.tasks.create({ title: 'third' })

        const updated = yield* until(withTimeout(second.promise))

        yield* stop()

        return { initial, updated, frames }
      }),
    )

    expect(result.initial).toHaveLength(2)
    expect((result.initial as Row[]).map(row => row.title).toSorted()).toEqual(['first', 'second'])

    // the third row arrived as a DELTA and was materialized into the local row map
    expect(result.updated).toHaveLength(3)
    expect((result.updated as Row[]).map(row => row.title)).toContain('third')
    expect(result.frames[1]!.version).toBeGreaterThan(result.frames[0]!.version)
  })

  it('shares one connection: two concurrent watches both receive, stopping one keeps the other live', async () => {
    const result = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* bootClientEnv()

        const client = yield* createClient<Api>({ url: info.url })

        yield* client.tasks.create({ title: 'seed' })

        const oneRows: (readonly unknown[])[] = []
        const twoRows: (readonly unknown[])[] = []
        const oneFirst = deferred<void>()
        const twoFirst = deferred<void>()
        const oneSecond = deferred<void>()
        const twoSecond = deferred<void>()
        const twoThird = deferred<void>()

        const stopOne = yield* client.tasks.list.watch({}, rows => {
          oneRows.push(rows)

          if (oneRows.length === 1) {
            oneFirst.resolve()
          }

          if (oneRows.length === 2) {
            oneSecond.resolve()
          }
        })
        const stopTwo = yield* client.tasks.list.watch({}, rows => {
          twoRows.push(rows)

          if (twoRows.length === 1) {
            twoFirst.resolve()
          }

          if (twoRows.length === 2) {
            twoSecond.resolve()
          }

          if (twoRows.length === 3) {
            twoThird.resolve()
          }
        })

        yield* until(withTimeout(Promise.all([oneFirst.promise, twoFirst.promise])))
        yield* client.tasks.create({ title: 'both see this' })
        yield* until(withTimeout(Promise.all([oneSecond.promise, twoSecond.promise])))

        const oneCountAfterStop = oneRows.length

        yield* stopOne()
        yield* client.tasks.create({ title: 'only two sees this' })
        yield* until(withTimeout(twoThird.promise))
        yield* stopTwo()

        return { oneRows, twoRows, oneCountAfterStop }
      }),
    )

    expect(result.oneRows[0]).toHaveLength(1)
    expect(result.twoRows[0]).toHaveLength(1)
    expect(result.oneRows[1]).toHaveLength(2)
    expect(result.twoRows[1]).toHaveLength(2)

    // the stopper ended watch one's frames — its count froze while watch two kept receiving
    expect(result.oneRows.length).toBe(result.oneCountAfterStop)
    expect(result.twoRows[2]).toHaveLength(3)
  })

  it('re-runs custom watchable queries: sync frames carry rows = [value]', async () => {
    const result = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* bootClientEnv()

        const client = yield* createClient<Api>({ url: info.url })

        const frames: (readonly unknown[])[] = []
        const first = deferred<void>()
        const next = deferred<void>()

        const stop = yield* client.tasks.stats.watch(undefined, rows => {
          frames.push(rows)

          if (frames.length === 1) {
            first.resolve()
          } else {
            next.resolve()
          }
        })

        yield* until(withTimeout(first.promise))
        yield* client.tasks.create({ title: 'bump the stats' })
        yield* until(withTimeout(next.promise))
        yield* stop()

        return frames
      }),
    )

    expect(result[0]).toEqual([{ total: 0, done: 0 }])
    expect(result.at(-1)).toEqual([{ total: 1, done: 0 }])
  })

  it('routes error frames to onError: watching a non-watchable fn', async () => {
    const failure = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* bootClientEnv()

        const client = yield* createClient<Api>({ url: info.url })

        const errored = deferred<Result.Failure<unknown>>()

        const stop = yield* client.tasks.get.watch({ id: 'x' }, () => {}, {
          onError: caught => {
            errored.resolve(caught)
          },
        })

        const caught = yield* until(withTimeout(errored.promise))

        yield* stop()

        // a bare Failure returned from the body would collapse into the run outcome — unpack it
        return { error: String(caught.error), message: caught.message, causes: caught.causes }
      }),
    )

    expect(failure.error).toBe('server:wizard.not-watchable')
    expect(failure.message).toContain('not watchable')
    expect(failure.causes.some(cause => cause.startsWith('requestId:'))).toBe(true)
  })
})
