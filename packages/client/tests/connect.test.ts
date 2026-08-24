/**
 * Futures end to end: every call is a `Future` — `yield*` it in effect world, `await` it in
 * promise land (a `Result` success; failures reject) — and every stream a `ClientFlow`
 * (`yield*` as a Flow, `for await` as an async iterable). `connectClient` is only the
 * promise-land bootstrap; the handle is the same.
 */
import type { ClientDef } from 'client:core'
import { connectClient, createClient } from 'client:core'
import { run, until } from 'std:effect'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import type { Api } from './fixture'
import { boot } from './fixture'

describe('connectClient — Futures in promise land', () => {
  it('calls, streams, watches, rotates tokens and closes without an effect runtime', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()

        yield* until(
          (async () => {
            const client = await connectClient<Api>({ url, token: 'boot-token' })

            // a call awaits to a Result success; `unwrap` is the std way in
            const made = unwrap(await client.demo.make({ title: 'facade' }))
            expect(made).toEqual({ id: 'n1', title: 'facade' })
            expect(client.$lastRequestId()).toBeTruthy()

            // a failure RESOLVES as the failure Result — the std `run()` contract
            const failed = await client.demo.explode({ code: 'demo.teapot' })
            expect(isFailure(failed)).toBe(true)
            expect((failed as { error: string }).error).toBe('demo.teapot')

            // an ndjson stream is `for await`-able
            const seen: number[] = []
            const counts = unwrap(await client.demo.count({ n: 3 }))

            for await (const value of counts) {
              seen.push(value)
            }

            expect(seen).toEqual([0, 1, 2])

            // breaking out of the loop cancels the stream (and its request)
            const big = unwrap(await client.demo.count({ n: 100_000 }))

            for await (const value of big) {
              if (value >= 1) {
                break
              }
            }

            // bytes come back as a platform stream — `Response` folds it
            const blob = unwrap(await client.demo.blob({ size: 2048 }))
            const bytes = await new Response(blob).arrayBuffer()
            expect(bytes.byteLength).toBe(2048)

            // `$setToken` rotates the bearer for every call from here on
            const before = unwrap(await client.demo.whoami()) as { authorization: string }
            client.$setToken('rotated')
            const after = unwrap(await client.demo.whoami()) as { authorization: string }
            expect(before.authorization).toBe('Bearer boot-token')
            expect(after.authorization).toBe('Bearer rotated')

            // the realtime feed is a ClientFlow: async-iterate, then cancel
            const rows = client.$rows<{ title: string }>('notes')
            const iterator = rows[Symbol.asyncIterator]()
            const first = await iterator.next()
            expect((first.value as ClientDef.Materialized).rows.length).toBe(0)
            await client.notes.create({ title: 'live', done: false })
            const second = await iterator.next()
            const materialized = second.value as ClientDef.Materialized<{ title: string }>
            expect(materialized.rows.map(row => row.title)).toEqual(['live'])
            await rows.cancel()

            await client.$close()
          })(),
        )
      }),
    )
  })
})

describe('futures — ONE handle, both worlds', () => {
  it('the same call is `yield*`able inline and `await`able as a scope job', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })

        // effect world: inline, in this task
        const inline = yield* client.demo.make({ title: 'effect' })
        expect(inline.title).toBe('effect')

        // promise land: the SAME handle, awaited (a detached job of the client's scope)
        const awaited = unwrap(yield* until(client.demo.make({ title: 'await' })))
        expect(awaited.title).toBe('await')

        // a stream: `yield*` drains it as a Flow …
        const flow = yield* client.demo.count({ n: 2 })
        const drained: number[] = []
        const subscription = yield* flow

        for (;;) {
          const step = yield* subscription.next()

          if (step.done) {
            break
          }

          drained.push(step.value)
        }

        expect(drained).toEqual([0, 1])

        // … and the SAME kind of value is `for await`-able
        const hybrid = unwrap(yield* until(client.demo.count({ n: 2 })))

        yield* until(
          (async () => {
            const seen: number[] = []

            for await (const value of hybrid) {
              seen.push(value)
            }

            expect(seen).toEqual([0, 1])
          })(),
        )
      }),
    )
  })
})
