/**
 * The observe docker leg against REAL Tempo + Loki (grafana/otel-lgtm, fed by `OtlpExporter` over
 * OTLP/protobuf) — design §11 assertions 1–8: real roots, ONE exception per failure across two
 * nodes (its Tempo copy keeping the innermost `Caused by:`), 4xx vs 5xx, resilience attempts,
 * websocket frames, messaging and queue links, link-mode inbound context, correlated Logger lines.
 * Skipped unless `scripts/test-observe.sh` (or the caller) set the backend urls.
 */
import { describe, expect, it } from 'bun:test'

import type { TempoSpan } from './helpers'
import {
  backends,
  exceptionLines,
  lokiQuery,
  NO_ROOT,
  TIMEOUT,
  tempoSearch,
  tempoTrace,
} from './helpers'
import { API, APP, FRAME_GAP_MS, INBOUND, LIVE, scenario, STORE } from './scenario'

/** The ONE span named `name` (of `kind`, when given) in `spans`. */
const only = (spans: readonly TempoSpan[], name: string, kind?: TempoSpan['kind']): TempoSpan => {
  const found = spans.filter(span => span.name === name && (!kind || span.kind === kind))

  if (found.length !== 1) {
    const seen = spans.map(span => `${span.kind} ${span.name}`).join(', ')

    throw new Error(`expected ONE ${kind ?? ''} span "${name}", got ${found.length}: ${seen}`)
  }

  return found[0]!
}

const exceptionsOf = (spans: readonly TempoSpan[]) =>
  spans.flatMap(span =>
    span.events.filter(event => event.name === 'exception').map(event => ({ span, event })),
  )

/** The Loki lines correlated to `traceId` across every service of the app. */
const traceLines = (traceId: string, sinceMs: number, atLeast = 1) =>
  lokiQuery(
    `{service_namespace="${APP}"} | trace_id="${traceId}"`,
    lines => lines.length >= atLeast,
    {
      sinceMs,
      confirm: true,
    },
  )

describe.skipIf(!backends.otlp || !backends.tempo || !backends.loki)(
  'observe leg — Tempo + Loki',
  () => {
    it(
      'the OTLP exporters delivered every record (none failed, rejected or dropped)',
      async () => {
        const run = await scenario()

        for (const node of [run.stats.a, run.stats.b]) {
          for (const signal of [node.otlp.spans, node.otlp.logs, node.otlp.metrics]) {
            expect(signal).toMatchObject({ failed: 0, rejected: 0, dropped: 0, lastError: null })
            expect(signal.sent).toBeGreaterThan(0)
          }
        }

        expect(run.statuses).toEqual({
          chain: 500,
          crash: 500,
          denied: 401,
          retry: 200,
          note: 200,
          inbound: 200,
        })
      },
      TIMEOUT,
    )

    it(
      '(1) one real root per trace, Tempo names it (never the placeholder), per-service names',
      async () => {
        const run = await scenario()
        const ids = [
          ...Object.values(run.traces),
          ...run.socket.frames.map(frame => frame.traceId),
          run.job.traceId,
        ]

        // node a mints every other trace with a leading `00` — the search must pad them back
        expect(ids.some(id => id.startsWith('00'))).toBe(true)

        const traces = await Promise.all(ids.map(id => tempoTrace(id)))

        for (const [at, spans] of traces.entries()) {
          const roots = spans.filter(span => span.parentSpanId === null)

          expect({ id: ids[at], roots: roots.map(span => span.name) }).toEqual({
            id: ids[at],
            roots: [expect.any(String)],
          })

          // every parent is IN the trace: nothing dangles
          const known = new Set(spans.map(span => span.spanId))

          for (const span of spans) {
            expect(span.parentSpanId === null || known.has(span.parentSpanId)).toBe(true)
          }
        }

        // the chain trace names every service: the edge (the node), the gateway action, the owner
        const chain = await tempoTrace(run.traces.chain, [`POST /${API}/save`, `${STORE}.save`])

        expect(new Set(chain.map(span => span.service))).toEqual(new Set([APP, API, STORE]))
        expect(only(chain, `POST /${API}/save`).service).toBe(APP)
        expect(only(chain, `${API}.save`).service).toBe(API)
        expect(only(chain, `${STORE}.save`, 'server').service).toBe(STORE)
        expect(only(chain, `${STORE}.save`, 'client').service).toBe(API)

        for (const span of chain) {
          expect(span.resource['service.namespace']).toBe(APP)
        }

        // TraceQL: every trace of the app is found, each with a REAL root service and name
        const hits = await tempoSearch(
          `{ resource.service.namespace = "${APP}" }`,
          found => ids.every(id => found.some(hit => hit.traceId === id)),
          { sinceMs: run.startedAt },
        )

        for (const id of ids) {
          const hit = hits.find(entry => entry.traceId === id)

          expect({ id, found: hit !== undefined }).toEqual({ id, found: true })
          expect(hit!.rootServiceName).toBeString()
          expect(hit!.rootServiceName).not.toBe(NO_ROOT)
          expect(hit!.rootTraceName).toBeString()
        }

        const chainHit = hits.find(hit => hit.traceId === run.traces.chain)!

        expect(chainHit).toMatchObject({ rootServiceName: APP, rootTraceName: `POST /${API}/save` })
      },
      TIMEOUT,
    )

    it(
      '(2) a 3-level chain across two nodes: ONE exception event in the whole trace — the owner’s',
      async () => {
        const run = await scenario()
        const spans = await tempoTrace(run.traces.chain, [
          `POST /${API}/save`,
          `${API}.save`,
          `${STORE}.save`,
        ])

        const exceptions = exceptionsOf(spans)

        expect(exceptions).toHaveLength(1)

        const owner = only(spans, `${STORE}.save`, 'server')
        const [{ span, event }] = exceptions as [(typeof exceptions)[number]]

        expect(span.spanId).toBe(owner.spanId)
        expect(owner).toMatchObject({ service: STORE, status: 'error' })
        expect(owner.attributes).toMatchObject({
          'error.type': 'store.save',
          'rpc.system.name': 'ozaco',
          'rpc.response.status_code': '500',
        })

        expect(event.attributes['exception.type']).toBe('store.save')
        expect(event.attributes['exception.message']).toBe('the note could not be saved')
        expect(event.attributes['ozaco.failure.chain']).toEqual([
          'store.save: the note could not be saved',
          'store.write: writing sector 7 failed',
          'std:result.unknown: TypeError: sector 7 is unreadable',
        ])

        // Tempo cuts attributes at 2048 bytes: the budgeted copy keeps every level's header —
        // the innermost root cause (the thrown TypeError's fold) included
        const stack = String(event.attributes['exception.stacktrace'])

        expect(Buffer.byteLength(stack)).toBeLessThanOrEqual(2048)
        expect(stack.startsWith('store.save: the note could not be saved')).toBe(true)
        expect(stack).toContain('Caused by: store.write: writing sector 7 failed')
        expect(stack).toContain('Caused by: std:result.unknown: TypeError: sector 7 is unreadable')
        expect(stack).not.toContain('at readSector')

        // the caller's side takes the status and the type — no exception of its own
        const client = only(spans, `${STORE}.save`, 'client')

        expect(client).toMatchObject({ service: API, status: 'error' })
        expect(client.attributes).toMatchObject({
          'error.type': 'store.save',
          'ozaco.failure.remote': true,
        })
        expect(only(spans, `${API}.save`).attributes['error.type']).toBe('store.save')

        const edge = only(spans, `POST /${API}/save`)

        expect(edge).toMatchObject({ kind: 'server', status: 'error' })
        expect(edge.attributes).toMatchObject({
          'http.response.status_code': 500,
          'error.type': 'store.save',
        })
      },
      TIMEOUT,
    )

    it(
      '(2) Loki: exactly ONE exception record for it — the whole chain, multi-line, at ERROR (17)',
      async () => {
        const run = await scenario()
        const spans = await tempoTrace(run.traces.chain, [`${STORE}.save`])
        const owner = only(spans, `${STORE}.save`, 'server')

        const exceptions = exceptionLines(await traceLines(run.traces.chain, run.startedAt))

        expect(exceptions).toHaveLength(1)

        const [record] = exceptions as [(typeof exceptions)[number]]

        expect(record.labels).toMatchObject({
          service_name: STORE,
          service_namespace: APP,
          span_id: owner.spanId!,
          trace_id: run.traces.chain,
          severity_number: '17',
          exception_type: 'store.save',
          otel_event_name: 'rpc.server.call.exception',
        })
        // the body is never blank: the full chain, multi-line (Loki keeps it whole)
        expect(record.line.split('\n').length).toBeGreaterThanOrEqual(3)
        expect(record.line.startsWith('store.save: the note could not be saved')).toBe(true)
        expect(record.line).toContain(
          'Caused by: std:result.unknown: TypeError: sector 7 is unreadable',
        )
        expect(record.line).not.toContain('at readSector')
      },
      TIMEOUT,
    )

    it(
      '(2) a raw throw across two nodes: server.internal on the wire, the fold in Tempo',
      async () => {
        const run = await scenario()
        const spans = await tempoTrace(run.traces.crash, [
          `POST /${API}/crash`,
          `${API}.crash`,
          `${STORE}.crash`,
        ])

        const exceptions = exceptionsOf(spans)

        expect(exceptions).toHaveLength(1)

        const owner = only(spans, `${STORE}.crash`, 'server')
        const [{ span, event }] = exceptions as [(typeof exceptions)[number]]

        expect(span.spanId).toBe(owner.spanId)
        expect(owner).toMatchObject({ service: STORE, status: 'error' })
        expect(owner.attributes).toMatchObject({
          'error.type': 'server.internal',
          'rpc.response.status_code': '500',
        })

        // `asFailure` folds the throw into ONE level (`std:result.unknown`, the Error its `raw`):
        // the exception is typed by the fold's tag, worded by its message — no frames
        expect(event.attributes['exception.type']).toBe('std:result.unknown')
        expect(event.attributes['exception.message']).toBe('RangeError: disk 9 is on fire')
        expect(event.attributes['ozaco.failure.chain']).toEqual([
          'std:result.unknown: RangeError: disk 9 is on fire',
        ])

        const stack = String(event.attributes['exception.stacktrace'])

        expect(stack.startsWith('std:result.unknown: RangeError: disk 9 is on fire')).toBe(true)
        expect(stack).not.toContain('Caused by:')
        expect(stack).not.toContain('at burnDisk')

        // the caller and the edge answer the stable wire tag, never the fold's
        const client = only(spans, `${STORE}.crash`, 'client')

        expect(client).toMatchObject({ service: API, status: 'error' })
        expect(client.attributes).toMatchObject({
          'error.type': 'server.internal',
          'ozaco.failure.remote': true,
        })
        expect(only(spans, `${API}.crash`).attributes['error.type']).toBe('server.internal')
        expect(only(spans, `POST /${API}/crash`).attributes).toMatchObject({
          'http.response.status_code': 500,
          'error.type': 'server.internal',
        })
      },
      TIMEOUT,
    )

    it(
      '(2) Loki: ONE exception record for the raw throw — the fold, at ERROR',
      async () => {
        const run = await scenario()
        const spans = await tempoTrace(run.traces.crash, [`${STORE}.crash`])
        const owner = only(spans, `${STORE}.crash`, 'server')

        const exceptions = exceptionLines(await traceLines(run.traces.crash, run.startedAt))

        expect(exceptions).toHaveLength(1)

        const [record] = exceptions as [(typeof exceptions)[number]]

        expect(record.labels).toMatchObject({
          service_name: STORE,
          span_id: owner.spanId!,
          trace_id: run.traces.crash,
          severity_number: '17',
          exception_type: 'std:result.unknown',
          otel_event_name: 'rpc.server.call.exception',
        })
        expect(record.line.startsWith('std:result.unknown: RangeError: disk 9 is on fire')).toBe(
          true,
        )
        expect(record.line).not.toContain('Caused by:')
        expect(record.line).not.toContain('at burnDisk')
      },
      TIMEOUT,
    )

    it(
      '(3) a 401: the dispatch span unset + error.type, ONE WARN record',
      async () => {
        const run = await scenario()
        const spans = await tempoTrace(run.traces.denied, [`GET /${API}/me`, `${API}.me`])

        const dispatch = only(spans, `${API}.me`)

        expect(dispatch).toMatchObject({ kind: 'internal', status: 'unset', service: API })
        expect(dispatch.attributes).toMatchObject({
          'error.type': 'server.unauthorized',
          'ozaco.auth.outcome': 'denied',
          'ozaco.auth.requirement': 'user',
        })

        const edge = only(spans, `GET /${API}/me`)

        expect(edge).toMatchObject({ status: 'unset' })
        expect(edge.attributes).toMatchObject({
          'http.response.status_code': 401,
          'error.type': 'server.unauthorized',
        })
        expect(spans.every(span => span.status !== 'error')).toBe(true)
        expect(exceptionsOf(spans).map(entry => entry.span.spanId)).toEqual([dispatch.spanId])

        const exceptions = exceptionLines(await traceLines(run.traces.denied, run.startedAt))

        expect(exceptions.map(line => line.labels['severity_number'])).toEqual(['13'])
        expect(exceptions[0]!.labels).toMatchObject({
          span_id: dispatch.spanId!,
          exception_type: 'server.unauthorized',
          otel_event_name: 'ozaco.action.exception',
        })
      },
      TIMEOUT,
    )

    it(
      '(4) retry then success: the dispatch span unset, attempt spans only for attempts ≥ 2',
      async () => {
        const run = await scenario()
        const spans = await tempoTrace(run.traces.retry, [`${API}.flaky`, 'resilience.attempt'])

        const dispatch = only(spans, `${API}.flaky`)

        expect(dispatch.status).toBe('unset')
        expect(dispatch.attributes['error.type']).toBeUndefined()

        const attempts = spans.filter(span => span.name === 'resilience.attempt')

        expect(attempts).toHaveLength(1)
        expect(attempts[0]!.attributes).toMatchObject({ 'ozaco.resilience.attempt': 2 })
        expect(attempts[0]!.parentSpanId).toBe(dispatch.spanId)
        expect(attempts[0]!.status).toBe('unset')

        // the retried first attempt: handled — ONE WARN on the dispatch span
        const exceptions = exceptionLines(await traceLines(run.traces.retry, run.startedAt))

        expect(exceptions.map(line => line.labels['severity_number'])).toEqual(['13'])
        expect(exceptions[0]!.labels['span_id']).toBe(dispatch.spanId!)
      },
      TIMEOUT,
    )

    it(
      '(5) websocket: one ROOT span per frame linked to the upgrade span, sends as events',
      async () => {
        const run = await scenario()

        expect(run.socket.replies).toEqual([
          { t: 'echo', text: 'a' },
          { t: 'echo', text: 'b' },
        ])
        expect(run.socket.frames).toHaveLength(2)
        expect(new Set(run.socket.frames.map(frame => frame.traceId)).size).toBe(2)

        const upgrades = new Set<string>()
        const durations: number[] = []
        const traces = await Promise.all(
          run.socket.frames.map(frame => tempoTrace(frame.traceId, [`WS ${LIVE}`])),
        )

        for (const [at, spans] of traces.entries()) {
          const frame = run.socket.frames[at]!
          const root = only(spans, `WS ${LIVE}`)

          expect(root).toMatchObject({ kind: 'server', parentSpanId: null, spanId: frame.spanId })
          expect(root.attributes).toMatchObject({ 'ozaco.ws.message.type': 'say' })

          expect(root.links).toHaveLength(1)
          expect(root.links[0]!.attributes).toEqual({ 'ozaco.link.reason': 'ws.session' })
          upgrades.add(`${root.links[0]!.traceId}/${root.links[0]!.spanId}`)

          const sends = root.events.filter(event => event.name === 'ws.send')

          expect(sends).toHaveLength(1)
          expect(sends[0]!.attributes).toMatchObject({ 'ozaco.ws.message.type': 'echo' })
          durations.push(...spans.map(span => span.end - span.start))
        }

        // both frames link the ONE upgrade span: a SERVER `GET {route}` that ended at the 101
        expect(upgrades.size).toBe(1)

        const [upgradeTrace, upgradeSpan] = [...upgrades][0]!.split('/') as [string, string]
        const spans = await tempoTrace(upgradeTrace, [`GET ${LIVE}`])
        const upgrade = only(spans, `GET ${LIVE}`)

        expect(upgrade).toMatchObject({ kind: 'server', spanId: upgradeSpan, parentSpanId: null })
        expect(upgrade.attributes['http.response.status_code']).toBe(101)
        durations.push(...spans.map(span => span.end - span.start))

        // the session lived for several frame gaps; no span covers more than a frame
        expect(run.socket.lifetimeMs).toBeGreaterThanOrEqual(FRAME_GAP_MS * 3)

        for (const duration of durations) {
          expect(duration).toBeLessThan(FRAME_GAP_MS)
        }
      },
      TIMEOUT,
    )

    it(
      '(6) emit ⇒ PRODUCER + CONSUMER linked by `creation`; the queue ⇒ a ROOT consumer linking the enqueue',
      async () => {
        const run = await scenario()
        const spans = await tempoTrace(run.traces.note, [
          'publish note.stored',
          'process note.stored',
          'send jobs',
          `${STORE}.put`,
        ])

        const publish = only(spans, 'publish note.stored')

        expect(publish).toMatchObject({ kind: 'producer', service: STORE })
        expect(publish.attributes).toMatchObject({
          'messaging.system': 'ozaco',
          'messaging.destination.name': 'note.stored',
        })

        // the consumer ran on the OTHER node: parented to the producer AND linking it
        const consume = only(spans, 'process note.stored')

        expect(consume).toMatchObject({
          kind: 'consumer',
          spanId: run.consumer.spanId,
          parentSpanId: publish.spanId,
        })
        expect(consume.resource['service.instance.id']).toBe('a')
        expect(consume.links).toEqual([
          {
            traceId: run.traces.note,
            spanId: publish.spanId,
            attributes: { 'ozaco.link.reason': 'creation' },
          },
        ])

        // the enqueue: a PRODUCER in the writer's trace …
        const send = only(spans, 'send jobs')

        expect(send).toMatchObject({ kind: 'producer', service: STORE })
        expect(send.attributes).toMatchObject({
          'messaging.system': 'ozaco.queue',
          'messaging.destination.name': 'jobs',
          'messaging.message.id': run.job.id,
        })

        // … the attempt: a ROOT consumer of its own trace, linking it
        expect(run.job.traceId).not.toBe(run.traces.note)

        const job = only(await tempoTrace(run.job.traceId, ['process jobs']), 'process jobs')

        expect(job).toMatchObject({ kind: 'consumer', parentSpanId: null, spanId: run.job.spanId })
        expect(job.attributes).toMatchObject({
          'messaging.system': 'ozaco.queue',
          'messaging.message.id': run.job.id,
          'ozaco.queue.attempt': 1,
        })
        expect(job.links).toEqual([
          {
            traceId: run.traces.note,
            spanId: send.spanId,
            attributes: { 'ozaco.link.reason': 'creation' },
          },
        ])
      },
      TIMEOUT,
    )

    it(
      '(7) an unexported client’s traceparent: a link-mode ROOT (`remote.parent`); its `-00` is still recorded',
      async () => {
        const run = await scenario()

        expect(run.traces.inbound).not.toBe(INBOUND.traceId)

        const spans = await tempoTrace(run.traces.inbound, [`GET /${API}/ping`])
        const edge = only(spans, `GET /${API}/ping`)

        expect(edge).toMatchObject({ kind: 'server', parentSpanId: null, service: APP })
        expect(edge.links).toEqual([
          {
            traceId: INBOUND.traceId,
            spanId: INBOUND.spanId,
            attributes: { 'ozaco.link.reason': 'remote.parent' },
          },
        ])

        // TraceQL finds it by the link — a real root, never `<root span not yet received>`
        const hits = await tempoSearch(
          `{ resource.service.namespace = "${APP}" && link.ozaco.link.reason = "remote.parent" }`,
          found => found.some(hit => hit.traceId === run.traces.inbound),
          { sinceMs: run.startedAt },
        )

        expect(hits.map(hit => hit.traceId)).toEqual([run.traces.inbound])
        expect(hits[0]).toMatchObject({ rootServiceName: APP, rootTraceName: `GET /${API}/ping` })
      },
      TIMEOUT,
    )

    it(
      '(8) Loki: `{service_name=…} | trace_id=…` returns the std Logger line with its span_id',
      async () => {
        const run = await scenario()
        const spans = await tempoTrace(run.traces.note, [`${STORE}.put`])
        const put = only(spans, `${STORE}.put`, 'server')

        const lines = await lokiQuery(
          `{service_name="${STORE}"} | trace_id="${run.traces.note}"`,
          found => found.some(line => line.line === 'note stored'),
          { sinceMs: run.startedAt, confirm: true },
        )
        const stored = lines.filter(line => line.line === 'note stored')

        expect(stored).toHaveLength(1)
        expect(stored[0]!.labels).toMatchObject({
          service_name: STORE,
          trace_id: run.traces.note,
          span_id: put.spanId!,
          severity_text: 'INFO',
          severity_number: '9',
          scope_name: '@ozaco/std/logger',
          note_size: '19',
        })
      },
      TIMEOUT,
    )
  },
)
