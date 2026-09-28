import { describe, expect, it } from 'bun:test'

import type { LogRow, SpanRow } from '../src/lib/api'
import { isExceptionLog, isRefused, setToken, storedToken } from '../src/lib/api'
import { outcomeOf, severityOf, statusText } from '../src/lib/format'
import { inlineEvents, mergeLive, treeOf } from '../src/lib/trace'

const span = (id: string, parent: string | null, extra: Partial<SpanRow> & { start: number }) =>
  ({
    trace_id: extra.trace_id ?? 't1',
    span_id: id,
    parent_span_id: parent,
    name: id,
    kind: 'internal',
    scope: '@ozaco/server',
    scope_version: null,
    service_name: 'app',
    service_instance_id: 'i1',
    end: extra.start + 1,
    duration_ms: 1,
    status_code: 'unset',
    status_message: null,
    error_type: null,
    root: parent === null,
    http_route: null,
    http_status: null,
    request_id: null,
    attributes: {},
    events: [],
    links: [],
    resource: {},
    ...extra,
  }) as SpanRow

describe('console — the waterfall tree', () => {
  it('places children under their parent, depth-first, siblings in start order', () => {
    const placed = treeOf([
      span('root', null, { start: 0 }),
      span('a', 'root', { start: 1 }),
      span('b', 'root', { start: 2 }),
      span('a1', 'a', { start: 1.5 }),
    ])

    expect(placed.map(entry => `${entry.depth}:${entry.span.span_id}`)).toEqual([
      '0:root',
      '1:a',
      '2:a1',
      '1:b',
    ])
  })

  it('a span whose parent is not stored (a remote caller) starts a tree; a cycle never loops', () => {
    const placed = treeOf([
      span('remote-child', 'elsewhere', { start: 0 }),
      span('x', 'y', { start: 1 }),
      span('y', 'x', { start: 2 }),
    ])

    expect(new Set(placed.map(entry => entry.span.span_id))).toEqual(
      new Set(['remote-child', 'x', 'y']),
    )
    expect(placed).toHaveLength(3)
    expect(placed[0]).toMatchObject({ depth: 0 })
  })
})

describe('console — the live list', () => {
  it('one row per trace (its real root), new traces newest first', () => {
    const prior = [span('old', null, { start: 10, trace_id: 'a' })]
    const merged = mergeLive(prior, [
      span('first', null, { start: 20, trace_id: 'b' }),
      span('second', null, { start: 30, trace_id: 'c' }),
      // the service node's local root of trace b arrives later — it started later: dropped
      span('inner', 'x', { start: 21, trace_id: 'b', root: true }),
      // an earlier root of a listed trace replaces the listed one, at its own place
      span('outer', null, { start: 5, trace_id: 'a' }),
    ])

    expect(merged.map(row => row.span_id)).toEqual(['second', 'first', 'outer'])
  })

  it('a trace is listed by its REAL root (no parent) — even one that starts after a remote child by clock skew', () => {
    // the service node's root ends — and is stored — first; the gateway's root comes later and
    // starts 0.2 ms AFTER it (two clocks): the parentless root is the trace's row all the same
    const early = mergeLive(
      [span('other', null, { start: 49, trace_id: 'o' })],
      [span('child', 'gw-client', { start: 50, trace_id: 't', root: true })],
    )

    expect(early.map(row => row.span_id)).toEqual(['child', 'other'])

    const settled = mergeLive(early, [span('gw', null, { start: 50.2, trace_id: 't' })])

    expect(settled.map(row => row.span_id)).toEqual(['gw', 'other'])

    // …and a child arriving after the real root never displaces it, however early it starts
    const again = mergeLive(settled, [
      span('late-child', 'gw-client', { start: 10, trace_id: 't', root: true }),
    ])

    expect(again.map(row => row.span_id)).toEqual(['gw', 'other'])
  })

  it('a better root moves its trace to that root`s place in the store order', () => {
    const prior = [
      span('c1', 'remote', { start: 60, trace_id: 'moved', root: true }),
      span('mid', null, { start: 55, trace_id: 'm' }),
      span('low', null, { start: 40, trace_id: 'l' }),
    ]
    const merged = mergeLive(prior, [span('real', null, { start: 50, trace_id: 'moved' })])

    expect(merged.map(row => row.span_id)).toEqual(['mid', 'real', 'low'])
    // between two roots with a remote parent, the earlier one is the pick
    expect(
      mergeLive(prior, [span('c0', 'remote', { start: 58, trace_id: 'moved', root: true })]).map(
        row => row.span_id,
      ),
    ).toEqual(['c0', 'mid', 'low'])
  })

  it('roots of the same millisecond take the store`s order (span id, higher first), not arrival', () => {
    const merged = mergeLive(
      [],
      [
        span('1a', null, { start: 40, trace_id: 'x' }),
        span('3c', null, { start: 40, trace_id: 'y' }),
        span('2b', null, { start: 40, trace_id: 'z' }),
        span('0f', null, { start: 41, trace_id: 'w' }),
      ],
    )

    expect(merged.map(row => row.span_id)).toEqual(['0f', '3c', '2b', '1a'])
  })
})

describe('console — formatting', () => {
  it('names outcomes, statuses, severities and exception records', () => {
    expect(outcomeOf(span('s', null, { start: 0, status_code: 'error', error_type: '500' }))).toBe(
      'error',
    )
    expect(outcomeOf(span('s', null, { start: 0, error_type: 'server.validation' }))).toBe('failed')
    expect(outcomeOf(span('s', null, { start: 0 }))).toBe('ok')
    expect(statusText(span('s', null, { start: 0, http_status: 404 }))).toBe('404')
    expect(statusText(span('s', null, { start: 0, error_type: 'todo.kaput' }))).toBe('todo.kaput')
    expect([1, 5, 9, 13, 17, 21].map(severityOf)).toEqual([
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
    ])

    const log = (event: string | null) => ({ event_name: event }) as LogRow

    expect(isExceptionLog(log('exception'))).toBe(true)
    expect(isExceptionLog(log('ozaco.action.exception'))).toBe(true)
    expect(isExceptionLog(log('ozaco.local'))).toBe(false)
    expect(isExceptionLog(log(null))).toBe(false)
  })
})

describe('console — every failure in full once', () => {
  it('a span`s `exception` event stays off its inline list while its exception record is stored', () => {
    const failed = span('s', null, {
      start: 0,
      events: [
        { name: 'cache.evict', time: 0.2 },
        { name: 'exception', time: 0.5, attributes: { 'exception.type': 'todo.kaput' } },
      ],
    })
    const record = {
      trace_id: 't1',
      span_id: 's',
      time: 0.5,
      event_name: 'ozaco.action.exception',
      attributes: { 'exception.type': 'todo.kaput' },
    } as unknown as LogRow
    const line = { ...record, event_name: null } as LogRow

    // the record is the failures list's block: the event is only the bar's mark
    expect(inlineEvents(failed, [line, record]).map(event => event.name)).toEqual(['cache.evict'])
    // no record stored (another span's, or logs switched off): the event is all there is
    expect(inlineEvents(failed, [line]).map(event => event.name)).toEqual([
      'cache.evict',
      'exception',
    ])
    expect(
      inlineEvents(failed, [{ ...record, span_id: 'other' } as LogRow]).map(event => event.name),
    ).toEqual(['cache.evict', 'exception'])
  })
})

describe('console — a gated API asks for a token', () => {
  const failure = (error: string, ...causes: string[]) => ({ error, message: 'no', causes })

  it('a 401 / 403 — or its tag — is a refusal; any other failure is not', () => {
    expect(isRefused(failure('server.unauthorized', 'req:r1', 'status:401'))).toBe(true)
    expect(isRefused(failure('server.forbidden', 'status:403'))).toBe(true)
    // a bare 401 / 403 without a tag of its own (a proxy's), the manifest fetch included
    expect(isRefused(failure('client.refused', 'status:401'))).toBe(true)
    expect(isRefused(failure('auth.jwt', 'status:401'))).toBe(true)

    expect(isRefused(failure('observe.not-found', 'status:404'))).toBe(false)
    expect(isRefused(failure('client.network'))).toBe(false)
    expect(isRefused(new Error('boom'))).toBe(false)
  })

  it('no storage (no window, a private one): the token is simply not kept, nothing throws', () => {
    setToken('tok')
    expect(storedToken()).toBeUndefined()
    setToken(null)
  })
})
