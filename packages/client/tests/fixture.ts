// oxlint-disable import/exports-last
import { column, DbClient, table } from 'db:core'
import type { ServerDef } from 'server:core'
import { action, createServer, service, stream } from 'server:core'
import { crud, Docs } from 'server:plugins'
import type { Operation } from 'std:effect'
import { sleep, until } from 'std:effect'
import { fail } from 'std:result'

import { MemoryAdapter } from 'db:impl/memory'
import { MemoryKv } from 'db:impl/memory-kv'
import { BunEdge } from 'server:impl/edge/bun'
import { BunIO } from 'std:io/impl/bun'
import { z } from 'zod'

export const notesTable = table('notes', { title: column.text(), done: column.boolean() })

const Note = z.object({ id: z.string(), title: z.string() })

/** Every plane the client must speak: values, path params, ndjson/sse/text/bytes, parts. */
export const demo = service('demo', {
  echo: action.query(
    {
      input: z.object({ text: z.string(), n: z.number().optional(), flag: z.boolean().optional() }),
    },
    function* ({ input }) {
      return input
    },
  ),
  byId: action.query(
    { input: z.object({ id: z.string() }), route: { method: 'GET', path: '/demo/:id' } },
    function* ({ input }) {
      return { id: input.id }
    },
  ),
  make: action.mutation(
    { input: z.object({ title: z.string().min(1) }), output: Note },
    function* ({ input }) {
      return { id: 'n1', title: input.title }
    },
  ),
  nothing: action.mutation({}, function* () {}),
  explode: action.query(
    { input: z.object({ code: z.string() }), errors: { 'demo.teapot': 418 } },
    function* ({ input }) {
      return yield* fail(input.code, `boom ${input.code}`)
    },
  ),
  count: action.stream(
    { input: z.object({ n: z.number() }), output: stream.ndjson(z.number()) },
    function* ({ input }) {
      return {
        *[Symbol.iterator]() {
          let at = 0
          return {
            *next() {
              if (at >= input.n) {
                return { done: true as const, value: undefined }
              }
              yield* sleep(1)
              return { done: false as const, value: at++ }
            },
          }
        },
      }
    },
  ),
  ticks: action.stream(
    { input: z.object({ n: z.number() }), output: stream.sse(z.object({ tick: z.number() })) },
    function* ({ input }) {
      return {
        *[Symbol.iterator]() {
          let at = 0
          return {
            *next() {
              if (at >= input.n) {
                return { done: true as const, value: undefined }
              }
              return { done: false as const, value: { tick: at++ } }
            },
          }
        },
      }
    },
  ),
  words: action.stream(
    { input: z.object({ text: z.string() }), output: stream.text() },
    function* ({ input }) {
      return {
        *[Symbol.iterator]() {
          const parts = input.text.split(' ')
          return {
            *next() {
              const next = parts.shift()
              return next === undefined
                ? { done: true as const, value: undefined }
                : { done: false as const, value: `${next} ` }
            },
          }
        },
      }
    },
  ),
  blob: action.stream(
    { input: z.object({ size: z.number() }), output: stream.bytes('application/octet-stream') },
    function* ({ input }) {
      return stream.from(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(input.size).fill(7))
            controller.close()
          },
        }),
        'bytes:application/octet-stream',
      )
    },
  ),
  upload: action.action(
    {
      input: stream.parts({
        fields: z.object({ name: z.string() }),
        streams: { file: stream.bytes('application/octet-stream') },
      }),
    },
    function* ({ input }) {
      const reader = (input.streams.file as ReadableStream<Uint8Array>).getReader()
      let size = 0
      for (;;) {
        const step = yield* until(reader.read())
        if (step.done) {
          break
        }
        size += step.value.length
      }
      return { name: input.fields.name, size }
    },
  ),
  ingest: action.action(
    { input: stream.bytes('application/octet-stream'), output: z.object({ size: z.number() }) },
    function* ({ input }) {
      const reader = (input as ReadableStream<Uint8Array>).getReader()
      let size = 0
      for (;;) {
        const step = yield* until(reader.read())
        if (step.done) {
          break
        }
        size += step.value.length
      }
      return { size }
    },
  ),
  whoami: action.query({}, function* ({ ctx }) {
    return { authorization: ctx.headers.authorization ?? null }
  }),
})

/** Side-channel state the probe service exposes (abort tracking, stream progress). */
export const probeState = {
  aborted: new Map<string, boolean>(),
  pumped: new Map<string, number>(),
}

/** Edge cases: headers, custom statuses, cause fidelity, deadlines, aborts, DELETE/array query. */
export const probe = service(
  'probe',
  {
    headers: action.query({}, function* ({ ctx }) {
      return ctx.headers
    }),
    teapot: action.query({ errors: { 'probe.teapot': 418 } }, function* () {
      return yield* fail('probe.teapot', 'short and stout', 'from:probe')
    }),
    caused: action.query({}, function* () {
      return yield* fail('probe.caused', 'root problem', 'cause:one', 'cause:two')
    }),
    sluggish: action.query(
      { input: z.object({ id: z.string(), ms: z.number() }) },
      function* ({ input, ctx }) {
        try {
          yield* sleep(input.ms)
        } finally {
          probeState.aborted.set(input.id, ctx.signal.aborted)
        }

        return { done: true }
      },
    ),
    endless: action.stream(
      { input: z.object({ id: z.string() }), output: stream.ndjson(z.number()) },
      function* ({ input }) {
        return {
          *[Symbol.iterator]() {
            let at = 0

            return {
              *next() {
                yield* sleep(10)
                probeState.pumped.set(input.id, ++at)

                return { done: false as const, value: at }
              },
            }
          },
        }
      },
    ),
    prune: action.mutation(
      {
        input: z.object({ ids: z.array(z.string()).default([]), dry: z.boolean().default(true) }),
        route: { method: 'DELETE', path: '/probe/prune' },
      },
      function* ({ input }) {
        return { ids: input.ids, dry: input.dry }
      },
    ),
  },
  { version: '2.1.0', description: 'edge cases' },
)

export const notes = crud(notesTable, { maxLimit: 50 })

/** A custom service carrying the notes delta-watch under its OWN key — no `_realtime`
 * convention anywhere, so the client can only find `/wall/feed` through the manifest. */
export const wall = service('wall', { feed: crud.realtime(notesTable) })

export type Api = ServerDef.Handle<[typeof demo, typeof probe, typeof notes.service]>['api']

/** Boot the fixture server on a random port; resolves its url. */
export function* boot(options?: { docsPath?: string }): Operation<{
  url: string
  server: ServerDef.Handle<[typeof demo, typeof probe, typeof notes.service, typeof wall]>
}> {
  yield* MemoryAdapter.use()
  yield* BunIO.use()
  yield* DbClient.use({ tables: [notesTable] })
  yield* MemoryKv.use()
  const server = yield* createServer({
    services: [demo, probe, notes.service, wall],
    edge: BunEdge,
    plugins: [Docs.use({ path: options?.docsPath ?? '/docs' })],
    name: 'client-fixture',
    version: '1.0.0',
  })
  const info = yield* server.listen({ port: 0 })
  return { url: info.url ?? `http://127.0.0.1:${info.port}`, server }
}
