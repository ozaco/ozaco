/**
 * The shared inspector API (`loadManifest` / `send` / `watch`): what the docs panel and the
 * observe console run on — against a REAL server. `send` resolves an `Outcome` (status ·
 * request id · elapsed · value/bytes) and streams progress chunks; `watch` feeds frames until
 * `stop()`; every entry point takes the handle OR the `connectClient` promise.
 */
import type { ClientDef } from 'client:core'
import { connectClient, loadManifest, send, watch } from 'client:core'
import { run, until } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import type { Api } from './fixture'
import { boot } from './fixture'

describe('the shared inspector API', () => {
  it('loadManifest, send (value · ndjson · bytes · failure) and watch — one client for all', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()

        yield* until(
          (async () => {
            // the connectClient PROMISE is enough — no ceremony
            const client = connectClient<Api>({ url })

            const manifest = await loadManifest(client)
            expect(manifest.manifest).toBe('ozaco/1')
            expect(manifest.services.some(service => service.name === 'demo')).toBe(true)

            // a value call: status, request id, elapsed, the value
            const made = await send(client, {
              service: 'demo',
              action: 'make',
              input: { title: 'inspector' },
            }).done
            expect(made.ok).toBe(true)
            expect(made.status).toBe(200)
            expect(made.requestId).toBeTruthy()
            expect(made.value).toEqual({ id: 'n1', title: 'inspector' })

            // an ndjson stream: chunks arrive as they come, the outcome collects them
            const chunks: unknown[] = []
            const counted = await send(
              client,
              { service: 'demo', action: 'count', input: { n: 3 } },
              chunk => chunks.push(chunk.kind === 'value' ? chunk.value : chunk),
            ).done
            expect(chunks).toEqual([0, 1, 2])
            expect(counted.streamed).toBe(true)
            expect(counted.value).toEqual([0, 1, 2])

            // bytes: size chunks tick up, the outcome carries the collected bytes
            let lastSize = 0
            const blob = await send(
              client,
              { service: 'demo', action: 'blob', input: { size: 2048 } },
              chunk => {
                if (chunk.kind === 'bytes') {
                  lastSize = chunk.size
                }
              },
            ).done
            expect(blob.bytes?.length).toBe(2048)
            expect(lastSize).toBe(2048)

            // a failure becomes a rendered WireFailure with the http status
            const failed = await send(client, {
              service: 'demo',
              action: 'explode',
              input: { code: 'demo.teapot' },
            }).done
            expect(failed.ok).toBe(false)
            expect(failed.error?.tag).toBe('demo.teapot')
            expect(failed.status).toBe(418)

            // watch: sync then delta, stop() ends it
            const frames: ClientDef.WatchFrame[] = []
            let ended: unknown = 'pending'

            const watching = watch(
              client,
              'notes',
              {},
              {
                onFrame: frame => frames.push(frame),
                onEnd: error => {
                  ended = error
                },
              },
            )

            await new Promise(resolve => {
              setTimeout(resolve, 100)
            })
            const handle = await client
            unwrap(await handle.notes.create({ title: 'watched', done: false }))
            await new Promise(resolve => {
              setTimeout(resolve, 100)
            })
            await watching.stop()

            expect(frames[0]?.t).toBe('sync')
            expect(frames.some(frame => frame.t === 'delta')).toBe(true)
            expect(ended === 'pending' || ended === null).toBe(true)

            await handle.$close()
          })(),
        )
      }),
    )
  })
})
