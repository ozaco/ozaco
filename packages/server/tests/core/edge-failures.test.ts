/**
 * Failures RETURNED as responses (never raised through a span) still land in the observe plane:
 * an EDGE-originated one (an unrouted 404, an undecodable body, a refused upgrade) is recorded on
 * the edge span itself — `error.type` + ONE exception record `http.server.request.exception` at
 * DEBUG (an artificial 4xx). A failure raised inside a dispatch is recorded where it originated
 * (the dispatch span — WARN for a 4xx) and only STAMPED (`error.type`) on the edge span: every
 * failure exactly once, never twice.
 */
import type { ServerDef } from 'server:core'
import { createServer, Edge } from 'server:core'
import { run, sleep, until } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail, unwrap } from 'std:result'
import type { TraceDef } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'

import { storage, todos } from '../helpers'

const probe = (url: string): Promise<'open' | 'rejected'> =>
  new Promise(resolve => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => {
      ws.close()
      resolve('open')
    })
    ws.addEventListener('error', () => resolve('rejected'))
    ws.addEventListener('close', event => {
      if (event.code !== 1000) {
        resolve('rejected')
      }
    })
  })

/** An observe hook collecting every span and log record the kernel reports. */
const spy = () => {
  const spans: TraceDef.SpanData[] = []
  const logs: TraceDef.LogData[] = []

  const plugin = definePlugin<ServerDef.PluginContext, []>({
    name: 'spy',
    version: '0',
    description: 'captures observe events',
    *setup() {
      const hooks: ServerDef.Hooks = {
        name: 'spy',
        *observe(event) {
          if (event.t === 'span') {
            spans.push(event.span)
          } else {
            logs.push(event.log)
          }
        },
      }
      return { hooks }
    },
  }).build()

  /** the edge (server) span of the request to `path`. */
  const edgeOf = (path: string): TraceDef.SpanData => {
    const found = spans.filter(
      span => span.kind === 'server' && span.attributes['url.path'] === path,
    )
    expect(found).toHaveLength(1)
    return found[0]!
  }

  /** exception records correlated to a trace. */
  const exceptionsIn = (traceId: string): TraceDef.LogData[] =>
    logs.filter(
      log => log.context?.traceId === traceId && log.attributes['exception.type'] !== undefined,
    )

  return { plugin, spans, logs, edgeOf, exceptionsIn }
}

describe('edge — returned failures are recorded', () => {
  it('404 route, bad input, socket reject and raised failures each land exactly once', async () => {
    const seen = spy()

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [seen.plugin.use()],
        })
        yield* Edge.actions.socket({
          path: '/guarded',
          *authorize() {
            return yield* fail('server.unauthorized', 'no way in')
          },
          *handler() {},
        })
        const info = yield* server.start({ port: 0 })
        const base = info.url!

        // an unrouted request → recorded on the edge span
        expect((yield* until(fetch(`${base}/nope`))).status).toBe(404)

        // an unparseable body never reaches a dispatch: edge-originated
        const unparseable = yield* until(
          fetch(`${base}/todos/create`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{not json',
          }),
        )
        expect(unparseable.status).toBe(400)

        // a WRONGLY TYPED body raises inside the dispatch — recorded there
        const invalid = yield* until(
          fetch(`${base}/todos/create`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: '' }),
          }),
        )
        expect(invalid.status).toBe(400)

        // socket: unknown path + rejected authorize
        const wsBase = base.replace('http', 'ws')
        expect(yield* until(probe(`${wsBase}/no-socket`))).toBe('rejected')
        expect(yield* until(probe(`${wsBase}/guarded`))).toBe('rejected')

        // a RAISED 4xx handler failure: recorded once, at its origin
        const raised = yield* until(fetch(`${base}/todos/explode?code=server.not-found`))
        expect(raised.status).toBe(404)
        yield* until(raised.text())

        yield* sleep(50)

        // unrouted: the edge span names the method only, carries the tag, stays unset; ONE
        // DEBUG record on it (Bun never upgrades an unrouted socket — it falls through to HTTP)
        for (const path of ['/nope', '/no-socket']) {
          const edge = seen.edgeOf(path)
          expect(edge.name).toBe('GET')
          expect(edge.attributes['http.response.status_code']).toBe(404)
          expect(edge.attributes['error.type']).toBe('server.not-found')
          expect(edge.status.code).toBe('unset')
          const records = seen.exceptionsIn(edge.context.traceId)
          expect(records).toHaveLength(1)
          expect(records[0]).toMatchObject({
            eventName: 'http.server.request.exception',
            severityNumber: 5,
          })
          expect(records[0]!.context?.spanId).toBe(edge.context.spanId)
        }

        // the two POSTs to the same route: the undecodable one (no dispatch span, DEBUG on the
        // edge span) and the invalid one (WARN on the dispatch span)
        const posts = seen.spans.filter(
          span => span.kind === 'server' && span.name === 'POST /todos/create',
        )
        expect(posts).toHaveLength(2)
        const badInput = posts.find(span => span.attributes['error.type'] === 'server.bad-request')
        const validation = posts.find(span => span.attributes['error.type'] === 'server.validation')
        expect(
          seen.spans.some(
            span => span.context.traceId === badInput!.context.traceId && span.kind !== 'server',
          ),
        ).toBe(false)
        const badRecords = seen.exceptionsIn(badInput!.context.traceId)
        expect(badRecords).toHaveLength(1)
        expect(badRecords[0]).toMatchObject({
          eventName: 'http.server.request.exception',
          severityNumber: 5,
        })

        expect(validation!.status.code).toBe('unset')
        const dispatch = seen.spans.find(
          span =>
            span.name === 'todos.create' && span.context.traceId === validation!.context.traceId,
        )
        expect(dispatch?.attributes['error.type']).toBe('server.validation')
        const validationRecords = seen.exceptionsIn(validation!.context.traceId)
        expect(validationRecords).toHaveLength(1)
        expect(validationRecords[0]).toMatchObject({
          eventName: 'ozaco.action.exception',
          severityNumber: 13,
        })
        expect(validationRecords[0]!.context?.spanId).toBe(dispatch!.context.spanId)

        // the refused upgrade: its span `GET /guarded` carries the verdict, one DEBUG record
        const guarded = seen.edgeOf('/guarded')
        expect(guarded.name).toBe('GET /guarded')
        expect(guarded.attributes['http.response.status_code']).toBe(401)
        expect(guarded.attributes['error.type']).toBe('server.unauthorized')
        const guardedRecords = seen.exceptionsIn(guarded.context.traceId)
        expect(guardedRecords).toHaveLength(1)
        expect(guardedRecords[0]!.severityNumber).toBe(5)

        // the raised not-found: exactly ONE record, from the dispatch span; the edge span only
        // carries the tag
        const explode = seen.edgeOf('/todos/explode')
        expect(explode.attributes['error.type']).toBe('server.not-found')
        expect(explode.events.filter(event => event.name === 'exception')).toHaveLength(0)
        const raisedRecords = seen.exceptionsIn(explode.context.traceId)
        expect(raisedRecords).toHaveLength(1)
        expect(raisedRecords[0]).toMatchObject({
          eventName: 'ozaco.action.exception',
          severityNumber: 13,
        })

        yield* server.stop()
      }),
    )
  })
})
