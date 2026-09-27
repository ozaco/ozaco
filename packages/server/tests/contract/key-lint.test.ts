/**
 * KEY LINT (design §11): every attribute key, span event name, event / link attribute key and log
 * event name a node emits — the sink-parity traffic (incl. the metrics derived from it) and every
 * plugin's traffic (Auth, CORS, Cache, Resilience, crud, HotReload, a network carrier with a db
 * queue) — keeps the rules: dotted lowercase segments under a namespace ozaco emits under (the
 * semconv captured-header keys keep their header name), never the old identity keys, span event
 * names ≤ 20 characters (Grafana cuts the rest), one spelling per concept.
 */
import type { ObserveDef } from 'server:core'

import { beforeAll, describe, expect, it } from 'bun:test'

import type { Emitted } from './lint'
import { EVENT_NAME_MAX, emittedOf, KEY, lint, metricKeysOf } from './lint'
import { runPluginTraffic } from './plugins'
import { runTraffic } from './traffic'

let emitted: Emitted[] = []
let plugins: Record<string, ObserveDef.Event[]> = {}

beforeAll(async () => {
  const traffic = await runTraffic()
  plugins = await runPluginTraffic()
  emitted = [
    ...emittedOf(traffic.events, 'traffic'),
    ...metricKeysOf(traffic.json.texts('metrics'), 'traffic'),
    ...Object.entries(plugins).flatMap(([name, events]) => emittedOf(events, name)),
  ]
}, 60_000)

const keysAt = (...places: Emitted['place'][]): Set<string> =>
  new Set(emitted.filter(item => places.includes(item.place)).map(item => item.key))

describe('contract — key lint', () => {
  it('the traffic reached every plugin', () => {
    for (const [name, events] of Object.entries(plugins)) {
      expect({ name, spans: events.some(event => event.t === 'span') }).toEqual({
        name,
        spans: true,
      })
    }

    const attributes = keysAt('span attribute', 'log attribute', 'event attribute')
    for (const key of [
      'ozaco.auth.outcome',
      'enduser.id',
      'ozaco.cors.allowed',
      'ozaco.cache.hit',
      'ozaco.resilience.attempt',
      'ozaco.resilience.breaker.state',
      'ozaco.crud.scoped',
      'ozaco.reload.generation',
      'db.system.name',
      'rpc.method',
      'ozaco.failure.remote',
      'ozaco.queue.attempt',
      'messaging.message.id',
      'http.request.header.user-agent',
      'ozaco.ws.message.body',
    ]) {
      expect({ key, seen: attributes.has(key) }).toEqual({ key, seen: true })
    }

    const events = keysAt('span event')
    for (const name of [
      'exception',
      'ozaco.auth.skip',
      'ozaco.cors.reject',
      'ozaco.cache.evict',
      'ozaco.breaker',
      'ozaco.crud.hook',
      'ozaco.queue.dead',
      'ozaco.ws.send',
    ]) {
      expect({ name, seen: events.has(name) }).toEqual({ name, seen: true })
    }

    expect(keysAt('link attribute')).toEqual(new Set(['ozaco.link.reason']))
    expect(keysAt('metric attribute').size).toBeGreaterThan(0)
  })

  it('every emitted key keeps the rules', () => {
    expect(lint(emitted)).toEqual([])
  })

  it('every span event name fits what Grafana shows', () => {
    const long = [...keysAt('span event')].filter(name => name.length > EVENT_NAME_MAX)
    expect(long).toEqual([])
  })

  it('the lint catches what it forbids — and lets through what it allows', () => {
    const at = (place: Emitted['place'], key: string): Emitted => ({ place, key, where: 'probe' })

    expect(
      lint([
        at('span attribute', 'ozaco.serviceId'),
        at('span attribute', 'ozaco.instance'),
        at('log attribute', 'ozaco.transport.name'),
        at('span attribute', 'Ozaco.upper'),
        at('span attribute', 'single'),
        at('span attribute', 'service.name'),
        at('span attribute', 'ozaco.ws.message_type'),
        at('event attribute', 'ozaco.ws.message.type'),
        at('span event', 'ozaco.cache.eviction.x'),
        at('log event', 'exception'),
        at('span event', 'exception'),
        at('span attribute', 'http.request.header.content-type'),
        at('span attribute', 'app.user_key'),
      ]),
    ).toEqual(
      [
        'keys differing only by case / "." / "_": ozaco.ws.message.type, ozaco.ws.message_type',
        'log attribute "ozaco.transport.name" (probe): a forbidden key',
        `span attribute "Ozaco.upper" (probe): not ${KEY.source}`,
        'span attribute "ozaco.instance" (probe): a forbidden key',
        'span attribute "ozaco.serviceId" (probe): a forbidden key',
        'span attribute "service.name" (probe): namespace "service" is not one ozaco emits under',
        `span attribute "single" (probe): not ${KEY.source}`,
        'span event "ozaco.cache.eviction.x" (probe): longer than 20 characters (22)',
      ].toSorted(),
    )
  })
})
