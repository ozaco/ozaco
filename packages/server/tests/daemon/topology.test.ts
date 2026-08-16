import {
  DataType,
  DefaultGateway,
  defineAction,
  defineService,
  Gateway,
  laneOf,
  parts,
  useSource,
  useTrace,
  value,
} from 'server:core'
import type { Multistream } from 'server:core'
import { Daemon } from 'server:daemon'
import type { DaemonModule } from 'server:daemon'
import { each } from 'std:effect'
import { install } from 'std:plugin'
import { fail } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BunGatewayAdapter } from 'server:gateway/bun'
import { z } from 'zod'

import { freshPrefix, natsUrl, startNode } from '../transport/nats-helpers'

const TodoErrors = { NotFound: 'todos.not-found' } as const

const makeUploadModules = (): DaemonModule[] => [
  {
    name: 'uploads',
    service: defineService({
      name: 'uploads',
      version: '1.0.0',
      actions: {
        ingest: defineAction(
          {
            input: [value(z.object({ tag: z.string() })), parts()],
            route: { method: 'POST', path: '/ingest' },
          },
          function* (body) {
            const source = (yield* useSource(DataType.multistream)) as Multistream
            const trace = yield* useTrace()
            const order: string[] = []
            const fields: Record<string, string> = {}
            const files: { filename: string; size: number; sum: number }[] = []

            for (const part of yield* each(source.parts)) {
              if (part.kind === 'field') {
                order.push(`field:${part.name}`)
                fields[part.name] = part.value
              } else {
                order.push(`file:${part.name}`)

                let size = 0
                let sum = 0

                for (const chunk of yield* each(part.data)) {
                  size += chunk.byteLength

                  for (const byte of chunk) {
                    sum = (sum + byte) % 65_521
                  }

                  yield* each.next()
                }

                files.push({ filename: part.filename, size, sum })
              }

              yield* each.next()
            }

            return { tag: body.tag, order, fields, files, lane: laneOf(trace) }
          },
        ),
      },
    }),
  },
]

const makeModules = (): DaemonModule[] => [
  {
    name: 'todos',
    service: defineService({
      name: 'todos',
      version: '1.0.0',
      actions: {
        get: defineAction(
          {
            input: z.object({ id: z.string() }),
            route: { method: 'GET', path: '/:id' },
            errors: { [TodoErrors.NotFound]: 404 },
          },
          function* (body) {
            if (body.id === 'missing') {
              return yield* fail(TodoErrors.NotFound, `todo "${body.id}" not found`)
            }

            const trace = yield* useTrace()

            return {
              id: body.id,
              requestId: trace.requestId,
              lane: laneOf(trace),
              origin: trace.origin,
              serviceId: trace.serviceId,
            }
          },
        ),
      },
    }),
  },
]

/**
 * The phase-8 crown jewel: the SAME daemon modules run as two processes-worth of scopes — an
 * edge-only gateway daemon and a headless owner daemon — glued by real NATS. Proves the whole
 * plan: requestId acceptance + echo, lane extension across the wire, failure fidelity, roles.
 */
describe.skipIf(!natsUrl)('daemon topology over NATS', () => {
  it('gateway daemon serves HTTP; service daemon owns the work; the trace spine survives', async () => {
    const prefix = freshPrefix()

    const owner = await startNode({
      prefix,
      *setup() {
        yield* install(Daemon, { env: { SERVICE: 'todos' }, modules: makeModules() })

        return yield* Daemon.actions.start()
      },
    })

    const edge = await startNode({
      prefix,
      *setup() {
        yield* install(BunGatewayAdapter)
        yield* install(DefaultGateway, { name: 'gw' })
        yield* install(Daemon, { env: { SERVICE: 'gateway' }, modules: makeModules() })

        return yield* Daemon.actions.start()
      },
    })

    try {
      const info = await edge.run(() => Gateway.actions.info())

      expect(info.port).toBeGreaterThan(0)

      // happy path: external request → edge → NATS → owner, correlation spine intact
      const res = await fetch(`${info.url}/todos/42`, {
        headers: { 'x-request-id': 'topo-req_1' },
      })
      const body = (await res.json()) as {
        id: string
        requestId: string
        lane: string
        origin: string
        serviceId: string
      }

      expect(res.status).toBe(200)
      expect(res.headers.get('x-request-id')).toBe('topo-req_1')
      expect(body.id).toBe('42')
      expect(body.requestId).toBe('topo-req_1')
      expect(body.lane).toBe('gw>todos')
      expect(body.origin).toBe('external')
      expect(body.serviceId).toMatch(/^todos@1\.0\.0#/u)

      // failure fidelity: business tag + mapped status + request id, across the wire
      const missing = await fetch(`${info.url}/todos/missing`)
      const failureBody = (await missing.json()) as { error: string; requestId: string }

      expect(missing.status).toBe(404)
      expect(failureBody.error).toBe(TodoErrors.NotFound)
      expect(failureBody.requestId).toMatch(/^r_/u)
      expect(missing.headers.get('x-request-id')).toBe(failureBody.requestId)
    } finally {
      await edge.close()
      await owner.close()
    }
  }, 20_000)

  it('remote multipart upload: edge parses, the input lane crosses NATS, the owner assembles', async () => {
    const prefix = freshPrefix()

    const owner = await startNode({
      prefix,
      *setup() {
        yield* install(Daemon, { env: { SERVICE: 'uploads' }, modules: makeUploadModules() })

        return yield* Daemon.actions.start()
      },
    })

    const edge = await startNode({
      prefix,
      *setup() {
        yield* install(BunGatewayAdapter)
        yield* install(DefaultGateway, { name: 'gw' })
        yield* install(Daemon, { env: { SERVICE: 'gateway' }, modules: makeUploadModules() })

        return yield* Daemon.actions.start()
      },
    })

    try {
      const info = await edge.run(() => Gateway.actions.info())

      const doc = new Uint8Array(200_000)
      let docSum = 0

      for (let i = 0; i < doc.length; i += 1) {
        doc[i] = i % 251
        docSum = (docSum + (i % 251)) % 65_521
      }

      const tiny = new Uint8Array([7, 11, 13])
      const form = new FormData()

      form.append('tag', 'e2e')
      form.append('doc', new Blob([doc]), 'doc.bin')
      form.append('tiny', new Blob([tiny]), 'tiny.bin')
      form.append('after', 'tail')

      const res = await fetch(`${info.url}/uploads/ingest`, {
        method: 'POST',
        body: form,
        headers: { 'x-request-id': 'topo-up_1' },
      })
      const body = (await res.json()) as {
        tag: string
        order: string[]
        fields: Record<string, string>
        files: { filename: string; size: number; sum: number }[]
        lane: string
      }

      expect(res.status).toBe(200)
      expect(res.headers.get('x-request-id')).toBe('topo-up_1')
      expect(body.tag).toBe('e2e')
      expect(body.lane).toBe('gw>uploads')
      expect(body.order).toEqual(['file:doc', 'file:tiny', 'field:after'])
      expect(body.fields).toEqual({ after: 'tail' })
      expect(body.files).toEqual([
        { filename: 'doc.bin', size: 200_000, sum: docSum },
        { filename: 'tiny.bin', size: 3, sum: 31 },
      ])
    } finally {
      await edge.close()
      await owner.close()
    }
  }, 30_000)
})
