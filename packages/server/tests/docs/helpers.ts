// oxlint-disable import/exports-last
import {
  Broker,
  DefaultGateway,
  defineAction,
  defineService,
  Gateway,
  parts,
  socket,
  stream,
  value,
} from 'server:core'
import type { GatewayInfo } from 'server:core'
import { flow, operation } from 'std:effect'
import { install } from 'std:plugin'
import { fail } from 'std:result'
import type { StandardSchemaV1 } from 'std:shared'

import { BunGatewayAdapter } from 'server:gateway/bun'
import { Docs } from 'server:plugin/docs'
import type { DocsOptions } from 'server:plugin/docs'
import { z } from 'zod'

import { bootstrap } from '../core/helpers'

export const NoteErrors = { NotFound: 'notes.not-found' } as const

/** A minimal hand-rolled Standard Schema that is NOT zod — must stay opaque in the manifest. */
export const opaqueSchema: StandardSchemaV1<{ raw: string }> = {
  '~standard': {
    version: 1,
    vendor: 'fixture',
    validate: input => ({ value: input as { raw: string } }),
  },
}

const numbers = () =>
  flow<{ n: number }, unknown>(
    (async function* generate() {
      yield { n: 1 }
      yield { n: 2 }
    })(),
  )

/** The docs fixture: routes, kinds, errors, stream + parts + socket channels, events. */
export const fixtureService = () =>
  defineService({
    name: 'notes',
    version: '2.1.0',
    description: 'notes fixture',
    events: {
      created: z.object({ id: z.string() }),
      imported: opaqueSchema,
    },
    actions: {
      get: defineAction(
        {
          title: 'Get note',
          description: 'Fetch one note by id.',
          input: z.object({ id: z.string() }),
          output: z.object({ id: z.string(), title: z.string() }),
          route: { method: 'GET', path: '/:id' },
          errors: { [NoteErrors.NotFound]: 404 },
          docs: { tags: ['notes'] },
        },
        function* (body) {
          if (body.id === 'missing') {
            return yield* fail(NoteErrors.NotFound, `note "${body.id}" not found`)
          }

          return { id: body.id, title: `note ${body.id}` }
        },
      ),
      create: defineAction(
        { input: z.object({ title: z.string() }), route: { method: 'POST', path: '/' } },
        function* (body) {
          return { id: 'n1', title: body.title }
        },
      ),
      ingest: defineAction(
        { input: opaqueSchema, route: { method: 'POST', path: '/ingest' } },
        function* (body) {
          return { raw: body.raw }
        },
      ),
      tail: defineAction(
        {
          kind: 'stream',
          output: stream(z.object({ n: z.number() })),
          route: { method: 'GET', path: '/feed', sse: true },
        },
        function* () {
          return numbers() as never
        },
      ),
      upload: defineAction(
        {
          input: [value(z.object({ note: z.string() })), parts()],
          route: { method: 'POST', path: '/upload' },
        },
        function* (body) {
          return { note: body.note }
        },
      ),
      watch: defineAction(
        { kind: 'action', input: [socket(z.object({ topic: z.string() }))] },
        function* () {
          // socket sessions are driven by the realtime layer — the fixture only declares the wire
        },
      ),
    },
  })

/** Real-HTTP docs bed: broker + fixture + bun gateway + docs mounted, server started on :0. */
export const bootDocsGateway = operation(function* (options?: DocsOptions) {
  yield* bootstrap()

  const notes = fixtureService()

  yield* Broker.actions.register(notes)
  yield* install(BunGatewayAdapter)
  yield* install(DefaultGateway, { name: 'gw' })
  yield* Gateway.actions.mount('/notes', notes)

  yield* install(Docs, options ?? { title: 'Fixture API', version: '3.0.0', auth: true })
  yield* Docs.actions.from({ prefix: '/notes', service: notes })
  yield* Docs.actions.mount()

  const info: GatewayInfo = yield* Gateway.actions.start({ port: 0 })

  return info
})
