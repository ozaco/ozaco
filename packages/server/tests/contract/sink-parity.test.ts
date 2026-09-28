/**
 * SINK PARITY (design §11, the user's rule "every sink holds exactly the same data"): ONE traffic
 * run with every sink on the node — the store, a memory exporter, stdout, OTLP/JSON, OTLP protobuf
 * and OpenObserve — and every sink's OUTPUT decoded back (the store through `Observe.actions.
 * trace`, the OTLP bodies through a JSON / protobuf reader of their own, stdout by parsing its
 * lines) into normalized records: the SAME set everywhere. The machine-readable sinks agree on
 * everything (typed values, times, flags, scopes, resources); stdout agrees on what its lines
 * carry (ids, parent, name, kind, service, status, attributes, events, links; severity range,
 * body, event name, scope).
 */
import { beforeAll, describe, expect, it } from 'bun:test'

import type { Traffic } from './traffic'
import { runTraffic } from './traffic'
import type { Log, Records, Span, TextLog, TextSpan } from './wire'
import {
  fromEvents,
  fromOtlpJson,
  fromOtlpProtobuf,
  fromStdout,
  fromStore,
  textRecords,
} from './wire'

let traffic: Traffic
let reference: Records<Span, Log>

beforeAll(async () => {
  traffic = await runTraffic()
  reference = fromEvents(traffic.events)
}, 30_000)

const spansNamed = (name: string): Span[] => reference.spans.filter(span => span.name === name)

const only = (name: string): Span => {
  const found = spansNamed(name)

  expect(found.map(span => span.name)).toEqual([name])

  return found[0]!
}

const logsWith = (body: string): Log[] => reference.logs.filter(log => log.body === body)

/** Every sink, decoded. */
const sinks = (): Record<string, Records<Span, Log>> => ({
  store: fromStore(traffic.store),
  'otlp/json': fromOtlpJson({
    traces: traffic.json.texts('traces'),
    logs: traffic.json.texts('logs'),
  }),
  'otlp/protobuf': fromOtlpProtobuf({
    traces: traffic.protobuf.bodies('traces'),
    logs: traffic.protobuf.bodies('logs'),
  }),
  openobserve: fromOtlpProtobuf({
    traces: traffic.openobserve.bodies('traces'),
    logs: traffic.openobserve.bodies('logs'),
  }),
})

describe('contract — the traffic', () => {
  it('made every record shape the kernel knows', () => {
    expect(traffic.statuses).toEqual({ item: 200, order: 200, broken: 500, missing: 404 })
    expect(traffic.replies).toEqual([{ t: 'hello' }, { t: 'echo', text: 'hi there' }])

    // a successful action: edge → dispatch → a user span with an event
    const item = spansNamed('GET /shop/items/:id')[0]!
    const itemDispatch = reference.spans.find(
      span => span.name === 'shop.item' && span.parentId === item.spanId,
    )!

    expect(itemDispatch).toBeDefined()

    const priced = reference.spans.find(
      span => span.name === 'price lookup' && span.parentId === itemDispatch.spanId,
    )!

    expect(priced.events.map(event => event.name)).toEqual(['app.priced'])

    // the nested ctx.call, the emit and its handler (a consumer linking its producer)
    const order = only('shop.order')

    expect(
      reference.spans.some(span => span.name === 'shop.item' && span.parentId === order.spanId),
    ).toBe(true)

    const publish = only('publish shop.ordered')
    const processed = only('process shop.ordered')

    expect(publish).toMatchObject({ kind: 'producer', parentId: order.spanId })
    expect(processed).toMatchObject({ kind: 'consumer', parentId: publish.spanId })
    expect(processed.links.map(link => link.spanId)).toEqual([publish.spanId])
    expect(processed.events.map(event => event.name)).toEqual(['app.shipped'])

    // the 3-level chain: ONE exception event on the dispatch, ONE ERROR record carrying it
    const broken = only('shop.broken')

    expect(broken.status).toEqual({ code: 'error', message: 'order broke' })
    expect(broken.events.map(event => event.name)).toEqual(['exception'])

    const exceptions = reference.logs.filter(log => log.eventName === 'ozaco.action.exception')

    expect(exceptions).toHaveLength(1)
    expect(exceptions[0]).toMatchObject({ spanId: broken.spanId, severityNumber: 17 })
    expect(exceptions[0]!.attributes['ozaco.failure.chain']).toEqual([
      'shop.broken: order broke',
      'shop.store: store failed',
      'std:result.unknown: TypeError: disk gone',
    ])

    // the 404: an unrouted edge span, its failure recorded at DEBUG
    const missing = only('GET')

    expect(missing.attributes).toMatchObject({
      'http.response.status_code': 404,
      'error.type': 'server.not-found',
    })
    expect(
      reference.logs.find(log => log.eventName === 'http.server.request.exception'),
    ).toMatchObject({ spanId: missing.spanId, severityNumber: 5 })

    // ctx.log and the std Logger: correlated to the dispatch span that wrote them
    for (const body of ['item looked up', 'std logger line']) {
      const lines = logsWith(body)

      expect(lines).toHaveLength(2)

      const dispatches = new Set(spansNamed('shop.item').map(span => span.spanId))

      expect(lines.every(line => line.spanId !== null && dispatches.has(line.spanId))).toBe(true)
    }

    expect(logsWith('std logger line')[0]!.scope.name).toBe('@ozaco/std/logger')
    expect(reference.logs.some(log => log.eventName === 'ozaco.local')).toBe(true)

    // the socket: the upgrade, one ROOT span per frame linked to it, a send event, the close
    const upgrade = only('GET /shop/live/:room')
    const frame = only('WS /shop/live/:room')

    expect(frame.parentId).toBeNull()
    expect(frame.links.map(link => link.spanId)).toEqual([upgrade.spanId])
    expect(frame.events.map(event => event.name)).toEqual(['ws.send'])
    expect(logsWith('heard')[0]!.spanId).toBe(frame.spanId)
    expect(logsWith('socket closed')[0]!.spanId).toBe(upgrade.spanId)

    // every record is correlated (so the store's trace view holds all of them)
    expect(reference.logs.every(log => log.traceId !== null)).toBe(true)
  })

  it('went out through every OTLP leg in its own encoding', () => {
    const types = (posted: Traffic['json']['posted']) =>
      new Set(posted.map(entry => entry.contentType))

    expect(types(traffic.json.posted)).toEqual(new Set(['application/json']))
    expect(types(traffic.protobuf.posted)).toEqual(new Set(['application/x-protobuf']))
    expect(types(traffic.openobserve.posted)).toEqual(new Set(['application/x-protobuf']))
    expect(
      traffic.openobserve.posted.every(entry =>
        /\/api\/default\/v1\/(?:traces|logs)$/u.test(entry.url),
      ),
    ).toBe(true)
  })
})

describe('contract — sink parity', () => {
  it('the store holds exactly the records the kernel reported', () => {
    expect(fromStore(traffic.store)).toEqual(reference)
  })

  it('OtlpExporter (OTLP/JSON) ships exactly them', () => {
    expect(sinks()['otlp/json']).toEqual(reference)
  })

  it('an OTLP protobuf destination ships exactly them', () => {
    expect(sinks()['otlp/protobuf']).toEqual(reference)
  })

  it('OpenObserveExporter (OTLP protobuf) ships exactly them', () => {
    expect(sinks()['openobserve']).toEqual(reference)
  })

  it('stdout prints exactly them — events with their stacktrace, exceptions with their chain', () => {
    expect(fromStdout(traffic.stdout)).toEqual(textRecords(reference))
  })

  it('every sink decodes to ONE set', () => {
    const texts: Record<string, Records<TextSpan, TextLog>> = {
      memory: textRecords(reference),
      stdout: fromStdout(traffic.stdout),
      ...Object.fromEntries(
        Object.entries(sinks()).map(([name, records]) => [name, textRecords(records)]),
      ),
    }

    for (const [name, records] of Object.entries(texts)) {
      expect({ name, records }).toEqual({ name, records: texts['memory']! })
    }

    for (const [name, records] of Object.entries(sinks())) {
      expect({ name, records }).toEqual({ name, records: reference })
    }
  })
})

describe('contract — the comparison is not blind', () => {
  it('a changed field in any sink breaks it', () => {
    // OTLP/JSON: one span renamed
    const [first, ...rest] = traffic.json.texts('traces')
    const payload = JSON.parse(first!)

    payload.resourceSpans[0].scopeSpans[0].spans[0].name = 'renamed'
    expect(
      fromOtlpJson({
        traces: [JSON.stringify(payload), ...rest],
        logs: traffic.json.texts('logs'),
      }),
    ).not.toEqual(reference)

    // the store: one log row missing
    const [view, ...views] = traffic.store

    expect(fromStore([{ ...view!, logs: view!.logs.slice(1) }, ...views])).not.toEqual(reference)

    // stdout: an exception event's stacktrace block missing
    const block = traffic.stdout.findIndex(line => /^ {4}· .* exception /u.test(line)) + 1

    expect(traffic.stdout[block]).toMatch(/^ {8}\S/u)
    expect(fromStdout(traffic.stdout.filter((_, at) => at !== block))).not.toEqual(
      textRecords(reference),
    )
  })

  it('the protobuf reader refuses what the OTLP schema does not have', () => {
    const [body, ...rest] = traffic.protobuf.bodies('traces')
    // field 99 (varint 1) appended to the ExportTraceServiceRequest
    const tampered = new Uint8Array([...body!, 0x98, 0x06, 0x01])

    expect(() => fromOtlpProtobuf({ traces: [tampered, ...rest], logs: [] })).toThrow(
      'field 99 is not in the OTLP schema',
    )
    expect(() =>
      fromOtlpProtobuf({ traces: [body!.subarray(0, body!.length - 1)], logs: [] }),
    ).toThrow(/truncated/u)
  })
})
