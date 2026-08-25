/**
 * End-to-end: every surface of `@ozaco/client` against a REAL server (BunEdge on a random
 * port) — calls and their options, the manifest lifecycle, failure fidelity, streaming in both
 * directions with cancellation, uploads in every sendable shape, the realtime feed, codegen.
 */
import { generate, pull } from 'client:codegen'
import { ClientErrors, createClient } from 'client:core'
import type { Flow, Operation } from 'std:effect'
import { attempt, run, scoped, sleep } from 'std:effect'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import type { Api } from './fixture'
import { boot, probeState } from './fixture'

function* drain<T>(flow: Flow<T, void>, max = Infinity): Operation<T[]> {
  const out: T[] = []
  const subscription = yield* flow

  while (out.length < max) {
    const step = yield* subscription.next()

    if (step.done) {
      break
    }

    out.push(step.value)
  }

  return out
}

describe('e2e — calls and options', () => {
  it('merges connection headers, per-call headers and the bearer; requestId can be pinned', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({
          url,
          headers: { 'x-app': 'panel', 'x-shared': 'connection' },
          token: 'static-token',
        })

        const seen = (yield* client.probe.headers(undefined, {
          headers: { 'x-shared': 'call', 'x-extra': 'yes' },
          requestId: 'pinned-request-id',
        })) as Record<string, string>

        // per-call wins over connection; both reach the server; the bearer rides along
        expect(seen['x-app']).toBe('panel')
        expect(seen['x-shared']).toBe('call')
        expect(seen['x-extra']).toBe('yes')
        expect(seen.authorization).toBe('Bearer static-token')
        expect(seen['x-request-id']).toBe('pinned-request-id')
        expect(client.$lastRequestId()).toBe('pinned-request-id')
      }),
    )
  })

  it('token resolvers are read per call — a rotation applies to the NEXT request', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        let token = 'first'
        const client = yield* createClient<Api>({ url, token: () => token })

        const before = (yield* client.probe.headers()) as Record<string, string>
        token = 'second'
        const after = (yield* client.probe.headers()) as Record<string, string>

        expect(before.authorization).toBe('Bearer first')
        expect(after.authorization).toBe('Bearer second')
      }),
    )
  })

  it('DELETE routes carry their input in the query string, arrays and booleans included', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })

        const pruned = yield* client.probe.prune({ ids: ['a', 'b'], dry: false })

        expect(pruned).toEqual({ ids: ['a', 'b'], dry: false })
      }),
    )
  })

  it('$callWithMeta resolves status, brand and the echoed request id', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })

        const value = yield* client.$callWithMeta('demo.make', { title: 'meta' })

        expect((value.value as AnyType).title).toBe('meta')
        expect(value.meta.status).toBe(200)
        expect(value.meta.brand).toBeNull()
        expect(value.meta.requestId).toBe(client.$lastRequestId()!)

        const streamed = yield* client.$callWithMeta('demo.count', { n: 1 })

        expect(streamed.meta.brand).toBe('ndjson')
      }),
    )
  })
})

describe('e2e — manifest lifecycle', () => {
  it('is fetched once, lazily, from the configured docs path', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot({ docsPath: '/openapi' })
        const requested: string[] = []
        const spy = ((input: AnyType, init: AnyType) => {
          requested.push(String(input))

          return fetch(input, init)
        }) as typeof fetch
        const client = yield* createClient<Api>({ url, docsPath: '/openapi', fetch: spy })

        yield* client.demo.echo({ text: 'a' })
        yield* client.demo.echo({ text: 'b' })
        yield* client.$manifest()

        const manifests = requested.filter(target => target.includes('/openapi/manifest'))

        expect(manifests).toHaveLength(1)
        expect((yield* client.$manifest()).name).toBe('client-fixture')
      }),
    )
  })

  it('a pre-fetched manifest skips the docs round trip entirely', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const direct = yield* createClient<Api>({ url })
        const manifest = yield* direct.$manifest()

        const requested: string[] = []
        const spy = ((input: AnyType, init: AnyType) => {
          requested.push(String(input))

          return fetch(input, init)
        }) as typeof fetch
        const client = yield* createClient<Api>({ url, manifest, fetch: spy })

        expect(yield* client.demo.echo({ text: 'cached' })).toEqual({ text: 'cached' })
        expect(requested.some(target => target.includes('/docs/manifest'))).toBe(false)
      }),
    )
  })

  it('an unreachable server fails client.network; an unknown action fails client.no-route', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const offline = yield* createClient({ url: 'http://127.0.0.1:1' })
        const down = yield* attempt(offline.$manifest())

        expect((down as AnyType).error).toBe(ClientErrors.Network)

        const client = yield* createClient<Api>({ url })
        const missing = yield* attempt(client.$call('demo.никого'))

        expect((missing as AnyType).error).toBe(ClientErrors.NoRoute)
      }),
    )
  })
})

describe('e2e — failure fidelity', () => {
  it('keeps tag, message and causes, and appends req + status breadcrumbs', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })

        const failed = yield* attempt(client.probe.caused())

        expect(isFailure(failed)).toBe(true)
        const failure = failed as AnyType
        expect(failure.error).toBe('probe.caused')
        expect(failure.message).toBe('root problem')
        expect(failure.causes.slice(0, 2)).toEqual(['cause:one', 'cause:two'])
        expect(failure.causes.some((cause: string) => cause.startsWith('req:'))).toBe(true)
        expect(failure.causes).toContain('status:500')
      }),
    )
  })

  it('honours per-action status overrides (a teapot answers 418)', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })

        const failed = (yield* attempt(client.probe.teapot())) as AnyType

        expect(failed.error).toBe('probe.teapot')
        expect(failed.causes).toContain('status:418')
      }),
    )
  })

  it('a missing path param fails client.configuration before any request leaves', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })

        const failed = (yield* attempt(client.demo.byId({} as AnyType))) as AnyType

        expect(failed.error).toBe(ClientErrors.Configuration)
        expect(failed.message).toContain('"id"')
      }),
    )
  })

  it('a per-call timeout fails client.timeout; the abandoned handler is aborted server-side', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })

        const failed = (yield* attempt(
          client.probe.sluggish({ id: 'timed', ms: 5000 }, { timeoutMs: 150 }),
        )) as AnyType

        expect(failed.error).toBe(ClientErrors.Timeout)

        // the fetch abort reaches the edge, which aborts the dispatch (`ctx.signal`)
        yield* sleep(150)
        expect(probeState.aborted.get('timed')).toBe(true)
      }),
    )
  })
})

describe('e2e — streams and cancellation', () => {
  it('abandoning an ndjson flow mid-stream stops the server-side pump', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })

        yield* scoped(function* () {
          const flow = yield* client.probe.endless({ id: 'left' })
          const first = yield* drain(flow as Flow<number, void>, 3)

          expect(first).toEqual([1, 2, 3])
          // the scope ends here: the response stream is cancelled
        })

        yield* sleep(200)
        const settled = probeState.pumped.get('left') ?? 0
        yield* sleep(200)

        // no further frames were produced once the consumer left
        expect((probeState.pumped.get('left') ?? 0) - settled).toBeLessThanOrEqual(1)
      }),
    )
  })

  it('accepts every sendable body shape: string, bytes, Blob and a ReadableStream', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })

        expect(yield* client.demo.ingest('plain text body')).toEqual({ size: 15 })
        expect(yield* client.demo.ingest(new Uint8Array(64))).toEqual({ size: 64 })
        expect(yield* client.demo.ingest(new Blob([new Uint8Array(128)]))).toEqual({ size: 128 })

        const streamed = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(100))
            controller.enqueue(new Uint8Array(28))
            controller.close()
          },
        })

        expect(yield* client.demo.ingest(streamed)).toEqual({ size: 128 })
      }),
    )
  })

  it('multipart uploads take Blob, bytes and string parts alongside coerced fields', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })

        const fromBlob = yield* client.demo.upload({
          fields: { name: 'blob.bin' },
          streams: { file: new Blob([new Uint8Array(256)]) },
        })

        expect(fromBlob).toEqual({ name: 'blob.bin', size: 256 })

        const fromText = yield* client.demo.upload({
          fields: { name: 'text.txt' },
          streams: { file: 'hello parts' },
        })

        expect(fromText).toEqual({ name: 'text.txt', size: 11 })
      }),
    )
  })
})

describe('e2e — realtime', () => {
  it('watch options filter and order the feed; deltas carry removals', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })

        const open = yield* client.notes.create({ title: 'open', done: false })
        yield* client.notes.create({ title: 'closed', done: true })

        yield* scoped(function* () {
          const frames = yield* client.$watch<{ _id: string; title: string }>('notes', {
            filter: { op: 'eq', field: 'done', value: false },
          })
          const sync = yield* frames.next()

          expect((sync.value as AnyType).t).toBe('sync')
          expect((sync.value as AnyType).rows.map((row: AnyType) => row.title)).toEqual(['open'])

          // a row leaving the filter arrives as a removal
          yield* client.notes.update({ id: open._id, done: true })
          const delta = yield* frames.next()

          expect((delta.value as AnyType).t).toBe('delta')
          expect((delta.value as AnyType).removed).toEqual([open._id])
        })
      }),
    )
  })

  it('a broken filter comes back as the server error frame, re-raised on the flow', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })

        yield* scoped(function* () {
          const frames = yield* client.$watch('notes', {
            filter: { op: 'eq', field: 'password', value: 'x' },
          })
          const failed = (yield* attempt(() => frames.next())) as AnyType

          expect(isFailure(failed)).toBe(true)
          expect(String(failed.error)).toBe('db.validation')
          expect(String(failed.message)).toContain('password')
        })
      }),
    )
  })

  it('$rows keeps a live table current through creates, updates and removals', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })

        yield* scoped(function* () {
          const rows = yield* client.$rows<{ _id: string; title: string }>('notes')
          const first = yield* rows.next()

          expect((first.value as AnyType).rows).toEqual([])

          const created = yield* client.notes.create({ title: 'one', done: false })
          const second = yield* rows.next()

          expect((second.value as AnyType).rows.map((row: AnyType) => row.title)).toEqual(['one'])

          yield* client.notes.remove({ id: created._id })
          const third = yield* rows.next()

          expect((third.value as AnyType).rows).toEqual([])
        })
      }),
    )
  })
})

describe('e2e — codegen', () => {
  it('pull() fetches the live manifest and emits a compilable Api with real routes', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const source = yield* pull(url)

        expect(source).toContain('export interface Api {')
        expect(source).toContain('readonly probe:')
        expect(source).toContain(
          "prune: { kind: 'mutation', method: 'DELETE', path: '/probe/prune' }",
        )

        // generate() over the same manifest is identical output
        const client = yield* createClient<Api>({ url })
        const manifest = yield* client.$manifest()

        expect(yield* generate(manifest)).toBe(source)
      }),
    )
  })
})
