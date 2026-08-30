import { generate } from 'client:codegen'
import { ClientErrors, createClient } from 'client:core'
import { attempt, run, sleep, until } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import { wsImpl } from 'std:ws'

import { describe, expect, it } from 'bun:test'

import type { Api } from './fixture'
import { boot } from './fixture'

const drain = function* <T>(flow: AnyType): Generator<AnyType, T[], AnyType> {
  const out: T[] = []
  const subscription = yield* flow
  for (;;) {
    const step = yield* subscription.next()
    if (step.done) {
      return out
    }
    out.push(step.value)
  }
}

describe('client', () => {
  it('typed calls over the manifest: query/path/json/204, failures with their tag + request id', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url, headers: { 'x-app': 'tests' } })

        // GET: query params with coercion-safe strings, numbers and booleans
        const echoed = yield* client.demo.echo({ text: '123', n: 2, flag: true })
        expect(echoed).toEqual({ text: '123', n: 2, flag: true })
        // path params
        expect(yield* client.demo.byId({ id: 'a b' })).toEqual({ id: 'a b' })
        // POST json + typed output
        const made = yield* client.demo.make({ title: 'hello' })
        expect(made.title).toBe('hello')
        // 204 → undefined
        expect(yield* client.demo.nothing(undefined)).toBeUndefined()
        expect(client.$lastRequestId()).toBeTruthy()

        // validation failure keeps the server tag and carries the request id
        const invalid = yield* attempt(client.demo.make({ title: '' }))
        expect((invalid as AnyType).error).toBe('server.validation')
        expect((invalid as AnyType).causes.some((cause: string) => cause.startsWith('req:'))).toBe(
          true,
        )
        // custom error → its tag, and the per-action status
        const teapot = yield* attempt(client.demo.explode({ code: 'demo.teapot' }))
        expect((teapot as AnyType).error).toBe('demo.teapot')
        // unknown action → client.no-route before any request
        const none = yield* attempt(client.$call('demo.nope'))
        expect((none as AnyType).error).toBe(ClientErrors.NoRoute)
        // headers + bearer reach the server
        const token = yield* createClient<Api>({ url, token: () => 'abc' })
        expect(yield* token.demo.whoami(undefined)).toEqual({ authorization: 'Bearer abc' })
      }),
    )
  })

  it('decodes outputs by brand: ndjson/sse → Flow, text, bytes; sends stream and parts bodies', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })
        expect(yield* drain<number>(yield* client.demo.count({ n: 3 }))).toEqual([0, 1, 2])
        expect(yield* drain(yield* client.demo.ticks({ n: 2 }))).toEqual([{ tick: 0 }, { tick: 1 }])
        expect(yield* client.demo.words({ text: 'a b c' })).toBe('a b c ')
        const blob = yield* client.demo.blob({ size: 10 })
        expect(blob instanceof ReadableStream).toBe(true)
        const bytes = yield* until(new Response(blob).arrayBuffer())
        expect(bytes.byteLength).toBe(10)

        // a stream body
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(300))
            controller.enqueue(new Uint8Array(200))
            controller.close()
          },
        })
        expect(yield* client.demo.ingest(body as AnyType)).toEqual({ size: 500 })
        // multipart parts: fields + a file
        const uploaded = yield* client.demo.upload({
          fields: { name: 'pic' },
          streams: { file: new Uint8Array(64) },
        } as AnyType)
        expect(uploaded).toEqual({ name: 'pic', size: 64 })
      }),
    )
  })

  it('resources: crud calls and a realtime watch that materializes rows', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })
        // v0.5: crud calls are TYPED end to end — the manifest-declared schemas carry the real
        // input types, so no cast is needed (this block compiling IS the regression test)
        const created = yield* client.notes.create({ title: 'one', done: false })
        expect(created.title).toBe('one')
        const listed = yield* client.notes.list({ limit: 10 })
        expect(listed.data).toBeTruthy()
        const fetched = yield* client.notes.get({ id: created._id })
        expect(fetched._id).toBe(created._id)

        const rows = yield* client.$rows<{ _id: string; title: string }>('notes')
        const first = yield* rows.next()
        expect((first.value as AnyType).rows.map((row: AnyType) => row.title)).toEqual(['one'])
        yield* client.notes.create({ title: 'two', done: true })
        const second = yield* rows.next()
        expect((second.value as AnyType).rows.map((row: AnyType) => row.title).toSorted()).toEqual([
          'one',
          'two',
        ])
        yield* client.notes.remove({ id: created._id })
        const third = yield* rows.next()
        expect((third.value as AnyType).rows.map((row: AnyType) => row.title)).toEqual(['two'])
        yield* sleep(10)
      }),
    )
  })

  it('codegen emits an Api from the manifest with brand-aware stream types', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient({ url })
        const manifest = yield* client.$manifest()
        const source = yield* generate(manifest)
        expect(source).toContain("import type { Flow } from '@ozaco/std/effect'")
        expect(source).toContain('readonly count: {')
        expect(source).toContain('readonly output: Flow<number, void>')
        expect(source).toContain("readonly kind: 'mutation'")
        expect(source).toContain("path: '/demo/:id'")
        expect(source).toContain('readonly output: ReadableStream<Uint8Array>')
        const bad = yield* attempt(generate({ nope: true }))
        expect((bad as AnyType).error).toBe(ClientErrors.Decode)
      }),
    )
  })
})

describe('client — realtime resume', () => {
  it('a dropped socket reconnects and resumes the watch from the last token', async () => {
    const sockets: WebSocket[] = []
    class Spy extends WebSocket {
      constructor(url: string | URL, options?: AnyType) {
        super(url, options)
        sockets.push(this)
      }
    }
    unwrap(
      await run(function* () {
        yield* wsImpl.set(Spy as AnyType)
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })
        yield* client.notes.create({ title: 'before-drop', done: false } as AnyType)
        const rows = yield* client.$rows<{ title: string }>('notes')
        const first = yield* rows.next()
        expect((first.value as AnyType).rows.map((row: AnyType) => row.title)).toEqual([
          'before-drop',
        ])
        // drop the live socket under the client: it redials and re-watches with `since` — the
        // next frame (a resync or a delta, by timing) still lands on the same flow
        expect(sockets).toHaveLength(1)
        sockets[0]!.close(4000, 'drop')
        yield* sleep(50)
        yield* client.notes.create({ title: 'after-drop', done: false } as AnyType)
        const next = yield* rows.next()
        expect((next.value as AnyType).rows.map((row: AnyType) => row.title).toSorted()).toEqual([
          'after-drop',
          'before-drop',
        ])
        expect(sockets.length).toBeGreaterThan(1)
      }),
    )
  })
})
