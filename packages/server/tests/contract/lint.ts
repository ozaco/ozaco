// oxlint-disable import/exports-last
/**
 * The key lint (design §11): every attribute key, span event name, link attribute key and log
 * event name a node emits, and the rules they keep.
 */
import type { ObserveDef } from 'server:core'
import type { AnyType } from 'std:shared'

export type Place =
  | 'span attribute'
  | 'span event'
  | 'event attribute'
  | 'link attribute'
  | 'log attribute'
  | 'log event'
  | 'metric attribute'

export interface Emitted {
  readonly place: Place
  readonly key: string
  /** where it was seen: the source and the record (`auth: span "guarded.me"`). */
  readonly where: string
}

/** Dotted lowercase segments, at least two. */
export const KEY = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u

/** The first segment of every key ozaco emits: the OTel semconv namespaces it uses + its own. */
export const NAMESPACES: ReadonlySet<string> = new Set([
  'http',
  'url',
  'server',
  'client',
  'network',
  'user_agent',
  'rpc',
  'messaging',
  'db',
  'error',
  'exception',
  'code',
  'enduser',
  'otel',
  'ozaco',
])

/** Keys that must never exist (the old kernel's identity keys: the resource carries these). */
export const FORBIDDEN: readonly string[] = ['ozaco.serviceId', 'ozaco.instance', 'ozaco.transport']

/** Grafana cuts span event names past this many characters. */
export const EVENT_NAME_MAX = 20

/** A span / log event name: lowercase dotted segments, no namespace required. */
const EVENT_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u

/**
 * Semconv's captured-header keys: `http.{request,response}.header.<name>`, the name the
 * LOWERCASED HTTP header name (an RFC 9110 token — `content-type` keeps its dash).
 */
const HEADER_KEY = /^http\.(?:request|response)\.header\.[a-z0-9!#$%&'*+.^_`|~-]+$/u

/** The traffic's OWN keys (user data, `app.*`) are not ozaco's to namespace. */
const USER = 'app'

/** `keys` seen at `where`, as one `place`. */
const seen = (where: string, place: Place, keys: Iterable<string>): Emitted[] =>
  [...keys].map(key => ({ place, key, where }))

/** Every key a batch of observed events carries, with where it was seen. */
export const emittedOf = (events: readonly ObserveDef.Event[], source: string): Emitted[] =>
  events.flatMap(event => {
    if (event.t === 'log') {
      const where = `${source}: log "${event.log.body.split('\n')[0]}"`

      return [
        ...seen(where, 'log attribute', Object.keys(event.log.attributes)),
        ...seen(where, 'log event', event.log.eventName === undefined ? [] : [event.log.eventName]),
      ]
    }

    const where = `${source}: span "${event.span.name}"`

    return [
      ...seen(where, 'span attribute', Object.keys(event.span.attributes)),
      ...event.span.events.flatMap(item => [
        ...seen(where, 'span event', [item.name]),
        ...seen(
          `${where} event "${item.name}"`,
          'event attribute',
          Object.keys(item.attributes ?? {}),
        ),
      ]),
      ...event.span.links.flatMap(link =>
        seen(`${where} link`, 'link attribute', Object.keys(link.attributes ?? {})),
      ),
    ]
  })

/** Every data point attribute key of OTLP/JSON metrics payloads. */
export const metricKeysOf = (payloads: readonly string[], source: string): Emitted[] =>
  payloads.flatMap(text =>
    (JSON.parse(text).resourceMetrics ?? []).flatMap((block: AnyType) =>
      (block.scopeMetrics ?? []).flatMap((scoped: AnyType) =>
        (scoped.metrics ?? []).flatMap((metric: AnyType) => {
          const points: AnyType[] =
            metric.gauge?.dataPoints ?? metric.sum?.dataPoints ?? metric.histogram?.dataPoints ?? []

          return points.flatMap(point =>
            (point.attributes ?? []).map((entry: AnyType): Emitted => ({
              place: 'metric attribute',
              key: entry.key,
              where: `${source}: metric "${metric.name}"`,
            })),
          )
        }),
      ),
    ),
  )

/** A key folded the way two spellings of one concept would collide: case, `.` and `_` ignored. */
const fold = (key: string): string => key.toLowerCase().replaceAll(/[._]/gu, '')

const isName = (placed: Place): boolean => placed === 'span event' || placed === 'log event'

/** The rule a key breaks, or null. */
const ruleOf = (item: Emitted): string | null => {
  const { key } = item

  // `exception` is THE semconv event name (a span event and the log record's event name)
  if (isName(item.place) && key === 'exception') {
    return null
  }

  if (item.place === 'span event' && key.length > EVENT_NAME_MAX) {
    return `longer than ${EVENT_NAME_MAX} characters (${key.length})`
  }

  if (FORBIDDEN.some(bad => key === bad || key.startsWith(`${bad}.`))) {
    return 'a forbidden key'
  }

  // an event name is a plain dotted name of its own — no namespace (`breaker`, `cache.evict`)
  if (isName(item.place)) {
    return EVENT_NAME.test(key) ? null : `not ${EVENT_NAME.source}`
  }

  if (HEADER_KEY.test(key)) {
    return null
  }

  if (!KEY.test(key)) {
    return `not ${KEY.source}`
  }

  const namespace = key.slice(0, key.indexOf('.'))

  return namespace === USER || NAMESPACES.has(namespace)
    ? null
    : `namespace "${namespace}" is not one ozaco emits under`
}

/** Every rule a set of emitted keys breaks, one line each (empty: clean). */
export const lint = (emitted: readonly Emitted[]): string[] => {
  const broken = new Set<string>()

  for (const item of emitted) {
    const rule = ruleOf(item)

    if (rule !== null) {
      broken.add(`${item.place} "${item.key}" (${item.where}): ${rule}`)
    }
  }

  // one concept, one key: no two spellings that differ only by case / `.` / `_`
  const spellings = new Map<string, Set<string>>()

  for (const item of emitted) {
    const folded = fold(item.key)

    spellings.set(folded, (spellings.get(folded) ?? new Set()).add(item.key))
  }

  for (const keys of spellings.values()) {
    if (keys.size > 1) {
      broken.add(`keys differing only by case / "." / "_": ${[...keys].toSorted().join(', ')}`)
    }
  }

  return [...broken].toSorted()
}
