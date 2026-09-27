/**
 * The observe docker leg against a REAL OpenObserve (fed by `OpenObserveExporter` over its OTLP
 * endpoints, protobuf) — design §11 assertions 2 and 9: the ONE exception record of a 3-level
 * chain, `span_status = 'ERROR'`, parseable `events` / `links` JSON, logs found by
 * `trace_id` + `span_id`, `otel_event_name` on event records — and the same spans Tempo holds
 * (every sink carries the same data). Skipped unless the backend urls are set.
 */
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { backends, openobserveSearch, TIMEOUT, tempoTrace } from './helpers'
import { API, LIVE, scenario, STORE } from './scenario'

/** Every span OpenObserve holds of `traceId`, polled until `names` are all there. */
const traceRows = (traceId: string, sinceMs: number, names: readonly string[]) =>
  openobserveSearch('traces', `SELECT * FROM "default" WHERE trace_id = '${traceId}'`, {
    sinceMs,
    confirm: true,
    done: rows => names.every(name => rows.some(row => row.operation_name === name)),
  })

const logRows = (where: string, sinceMs: number, atLeast = 1) =>
  openobserveSearch('logs', `SELECT * FROM "default" WHERE ${where}`, {
    sinceMs,
    confirm: true,
    done: rows => rows.length >= atLeast,
  })

/** The ONE row named `name` (and kind `kind` — OpenObserve's number: 2 server, 3 client). */
const row = (rows: readonly AnyType[], name: string, kind?: string): AnyType => {
  const found = rows.filter(
    entry => entry.operation_name === name && (!kind || String(entry.span_kind) === kind),
  )

  if (found.length !== 1) {
    const seen = rows.map(entry => `${entry.span_kind} ${entry.operation_name}`).join(', ')
    throw new Error(
      `expected ONE row "${name}" (kind ${kind ?? 'any'}), got ${found.length}: ${seen}`,
    )
  }
  return found[0]
}

const json = (value: unknown): AnyType[] => JSON.parse(String(value ?? '[]'))

/** A link's span context and reason, however OpenObserve nests it. */
const linkOf = (link: AnyType) => ({
  traceId: link.context?.traceId ?? link.traceId ?? link.trace_id,
  spanId: link.context?.spanId ?? link.spanId ?? link.span_id,
  reason: link['ozaco.link.reason'] ?? link.attributes?.['ozaco.link.reason'],
})

describe.skipIf(!backends.otlp || !backends.openobserve)('observe leg — OpenObserve', () => {
  it(
    'the OpenObserve exporters delivered every record (none failed, rejected or dropped)',
    async () => {
      const run = await scenario()

      for (const node of [run.stats.a, run.stats.b]) {
        expect(node.openobserve).not.toBeNull()
        for (const signal of [node.openobserve!.spans, node.openobserve!.logs]) {
          expect(signal).toMatchObject({ failed: 0, rejected: 0, dropped: 0, lastError: null })
          expect(signal.sent).toBeGreaterThan(0)
        }
      }
    },
    TIMEOUT,
  )

  it(
    '(2) exactly ONE exception record for the chain — multi-line body, severity 17, on the owner',
    async () => {
      const run = await scenario()
      const spans = await traceRows(run.traces.chain, run.startedAt, [`${STORE}.save`])
      const owner = row(spans, `${STORE}.save`, '2')

      const logs = await logRows(`trace_id = '${run.traces.chain}'`, run.startedAt)
      const exceptions = logs.filter(entry => entry.exception_type)
      expect(exceptions).toHaveLength(1)

      const [record] = exceptions
      expect(record).toMatchObject({
        service_name: STORE,
        span_id: owner.span_id,
        exception_type: 'store.save',
        exception_message: 'the note could not be saved',
        otel_event_name: 'rpc.server.call.exception',
      })
      expect(String(record.severity)).toBe('17')

      const body = String(record.body ?? '')
      expect(body.split('\n').length).toBeGreaterThanOrEqual(3)
      expect(body.startsWith('store.save: the note could not be saved')).toBe(true)
      expect(body).toContain('Caused by: std:result.unknown: TypeError: sector 7 is unreadable')
      expect(json(record.ozaco_failure_chain)).toHaveLength(3)
    },
    TIMEOUT,
  )

  it(
    '(2) a raw throw: ONE exception record of its fold, server.internal spans',
    async () => {
      const run = await scenario()
      const spans = await traceRows(run.traces.crash, run.startedAt, [
        `POST /${API}/crash`,
        `${STORE}.crash`,
      ])
      const owner = row(spans, `${STORE}.crash`, '2')
      expect(owner).toMatchObject({ span_status: 'ERROR', error_type: 'server.internal' })
      expect(row(spans, `${STORE}.crash`, '3')).toMatchObject({ error_type: 'server.internal' })

      const logs = await logRows(`trace_id = '${run.traces.crash}'`, run.startedAt)
      const exceptions = logs.filter(entry => entry.exception_type)
      expect(exceptions).toHaveLength(1)

      const [record] = exceptions
      expect(record).toMatchObject({
        service_name: STORE,
        span_id: owner.span_id,
        exception_type: 'std:result.unknown',
        exception_message: 'RangeError: disk 9 is on fire',
        otel_event_name: 'rpc.server.call.exception',
      })
      expect(String(record.severity)).toBe('17')

      const body = String(record.body ?? '')
      // ONE level: the fold, no frames
      expect(body.startsWith('std:result.unknown: RangeError: disk 9 is on fire')).toBe(true)
      expect(body).not.toContain('Caused by:')
      expect(body).not.toContain('at burnDisk')
      expect(json(record.ozaco_failure_chain)).toHaveLength(1)
    },
    TIMEOUT,
  )

  it(
    "(9) traces: span_status 'ERROR' where the chain failed, events and links parse as JSON",
    async () => {
      const run = await scenario()
      const spans = await traceRows(run.traces.chain, run.startedAt, [
        `POST /${API}/save`,
        `${API}.save`,
        `${STORE}.save`,
      ])

      const owner = row(spans, `${STORE}.save`, '2')
      expect(owner).toMatchObject({
        span_status: 'ERROR',
        error_type: 'store.save',
        service_name: STORE,
      })
      const client = row(spans, `${STORE}.save`, '3')
      expect(client).toMatchObject({
        span_status: 'ERROR',
        service_name: API,
        error_type: 'store.save',
      })
      // OpenObserve keeps a boolean attribute as its string
      expect(String(client.ozaco_failure_remote)).toBe('true')
      expect(row(spans, `POST /${API}/save`).span_status).toBe('ERROR')

      // ONE exception event across the trace, the whole chain in its stacktrace
      const events = spans.flatMap(entry => json(entry.events).map(event => ({ entry, event })))
      const exceptions = events.filter(({ event }) => event.name === 'exception')
      expect(exceptions).toHaveLength(1)
      expect(exceptions[0]!.entry.span_id).toBe(owner.span_id)
      expect(String(exceptions[0]!.event['exception.stacktrace'])).toContain(
        'Caused by: std:result.unknown: TypeError: sector 7 is unreadable',
      )
      expect(exceptions[0]!.event['ozaco.failure.chain']).toHaveLength(3)

      // links: a websocket frame links its upgrade, the queue attempt links the enqueue
      const frame = run.socket.frames[0]!
      const frameRow = row(
        await traceRows(frame.traceId, run.startedAt, [`WS ${LIVE}`]),
        `WS ${LIVE}`,
      )
      const frameLinks = json(frameRow.links).map(linkOf)
      expect(frameLinks).toHaveLength(1)
      expect(frameLinks[0]!.reason).toBe('ws.session')
      expect(json(frameRow.events).map(event => event.name)).toContain('ozaco.ws.send')

      const noted = await traceRows(run.traces.note, run.startedAt, ['send jobs'])
      const jobRow = row(
        await traceRows(run.job.traceId, run.startedAt, ['process jobs']),
        'process jobs',
      )
      expect(json(jobRow.links).map(linkOf)).toEqual([
        { traceId: run.traces.note, spanId: row(noted, 'send jobs').span_id, reason: 'creation' },
      ])
    },
    TIMEOUT,
  )

  it(
    '(9) logs by trace_id + span_id: the exception and the Logger line, `otel_event_name` on events',
    async () => {
      const run = await scenario()
      const chain = await traceRows(run.traces.chain, run.startedAt, [`${STORE}.save`])
      const owner = row(chain, `${STORE}.save`, '2')

      const exceptions = await logRows(
        `trace_id = '${run.traces.chain}' AND span_id = '${owner.span_id}'`,
        run.startedAt,
      )
      expect(exceptions).toHaveLength(1)
      expect(exceptions[0]).toMatchObject({
        otel_event_name: 'rpc.server.call.exception',
        o2_event_name: 'rpc.server.call.exception',
      })

      const note = await traceRows(run.traces.note, run.startedAt, [`${STORE}.put`])
      const put = row(note, `${STORE}.put`, '2')
      const lines = await logRows(
        `trace_id = '${run.traces.note}' AND span_id = '${put.span_id}'`,
        run.startedAt,
      )
      expect(lines.map(entry => entry.body)).toEqual(['note stored'])
      expect(lines[0]).toMatchObject({ service_name: STORE, severity: 'INFO' })
      // a plain Logger line is no event: no event name at all
      expect(lines[0].otel_event_name).toBeUndefined()
    },
    TIMEOUT,
  )

  it.skipIf(!backends.tempo)(
    'every sink holds the same spans: OpenObserve and Tempo agree on each trace',
    async () => {
      const run = await scenario()

      const compare = async (traceId: string) => {
        const tempo = await tempoTrace(traceId)
        const rows = await traceRows(
          traceId,
          run.startedAt,
          tempo.map(span => span.name),
        )
        return { tempo, rows }
      }
      const traces = await Promise.all(
        [run.traces.chain, run.traces.note, run.job.traceId].map(compare),
      )

      for (const { tempo, rows } of traces) {
        const inTempo = tempo
          .map(
            span =>
              `${span.spanId} ${span.parentSpanId ?? '-'} ${span.name} ${span.service} ${span.status}`,
          )
          .toSorted()
        const inOpenObserve = rows
          .map(
            entry =>
              `${entry.span_id} ${entry.reference_parent_span_id || '-'} ${entry.operation_name} ${entry.service_name} ${String(entry.span_status).toLowerCase()}`,
          )
          .toSorted()
        expect(inOpenObserve).toEqual(inTempo)
      }
    },
    TIMEOUT,
  )
})
