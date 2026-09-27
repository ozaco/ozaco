import { run } from 'std:effect'
import { unwrap } from 'std:result'
import {
  ActiveSpan,
  extract,
  formatTracestate,
  getTracestate,
  inject,
  isValidContext,
  parseTraceparent,
  parseTracestate,
  passThrough,
  setTracestate,
  span,
  suppressed,
  traceparentOf,
} from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { traced } from './helpers'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN = '00f067aa0ba902b7'
const VALID = `00-${TRACE}-${SPAN}-01`

const headers = (entries: Record<string, string | string[]>) => (name: string) =>
  entries[name] ?? null

describe('parseTraceparent (W3C level 2)', () => {
  it('parses a valid version-00 header into a remote context', () => {
    expect(parseTraceparent(VALID)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      flags: 1,
      remote: true,
    })
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-00`)?.flags).toBe(0)
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-03`)?.flags).toBe(3)
  })

  it('keeps only the sampled and random flag bits', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-ff`)?.flags).toBe(3)
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-04`)?.flags).toBe(0)
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-09`)?.flags).toBe(1)
  })

  it('ignores optional whitespace around the value', () => {
    expect(parseTraceparent(` \t${VALID} `)?.traceId).toBe(TRACE)
  })

  it('rejects uppercase hex anywhere', () => {
    expect(parseTraceparent(`00-${TRACE.toUpperCase()}-${SPAN}-01`)).toBeNull()
    expect(parseTraceparent(`00-${TRACE}-${SPAN.toUpperCase()}-01`)).toBeNull()
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-0A`)).toBeNull()
    expect(parseTraceparent(`0A-${TRACE}-${SPAN}-01`)).toBeNull()
  })

  it('rejects all-zero trace and span ids', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN}-01`)).toBeNull()
    expect(parseTraceparent(`00-${TRACE}-${'0'.repeat(16)}-01`)).toBeNull()
  })

  it('rejects version ff and malformed versions', () => {
    expect(parseTraceparent(`ff-${TRACE}-${SPAN}-01`)).toBeNull()
    expect(parseTraceparent(`0g-${TRACE}-${SPAN}-01`)).toBeNull()
    expect(parseTraceparent(`0-${TRACE}-${SPAN}-01`)).toBeNull()
  })

  it('rejects version 00 with anything after the flags', () => {
    expect(parseTraceparent(`${VALID}-extra`)).toBeNull()
    expect(parseTraceparent(`${VALID}0`)).toBeNull()
  })

  it('parses a higher version with the 00 layout (extra fields after a dash)', () => {
    expect(parseTraceparent(`01-${TRACE}-${SPAN}-01`)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      flags: 1,
      remote: true,
    })
    expect(parseTraceparent(`cc-${TRACE}-${SPAN}-01-what-the-future-holds`)?.spanId).toBe(SPAN)
    // after the flags there must be a dash (or the end)
    expect(parseTraceparent(`cc-${TRACE}-${SPAN}-01what`)).toBeNull()
  })

  it('rejects wrong lengths, bad delimiters and non-strings — never throws', () => {
    expect(parseTraceparent('')).toBeNull()
    expect(parseTraceparent(`00-${TRACE.slice(1)}-${SPAN}-01`)).toBeNull()
    expect(parseTraceparent(`00-${TRACE}-${SPAN.slice(1)}-001`)).toBeNull()
    expect(parseTraceparent(`00_${TRACE}-${SPAN}-01`)).toBeNull()
    expect(parseTraceparent(`00-${TRACE}_${SPAN}-01`)).toBeNull()
    expect(parseTraceparent(`00-${TRACE}-${SPAN}_01`)).toBeNull()
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-0x`)).toBeNull()
    expect(parseTraceparent(undefined)).toBeNull()
    expect(parseTraceparent(42)).toBeNull()
    expect(parseTraceparent({ toString: () => VALID })).toBeNull()
  })

  it('formats a context back to the same header (only known flags go out)', () => {
    expect(traceparentOf({ traceId: TRACE, spanId: SPAN, flags: 1 })).toBe(VALID)
    expect(traceparentOf({ traceId: TRACE, spanId: SPAN, flags: 0xff })).toBe(
      `00-${TRACE}-${SPAN}-03`,
    )
    expect(traceparentOf(parseTraceparent(`01-${TRACE}-${SPAN}-02-x`)!)).toBe(
      `00-${TRACE}-${SPAN}-02`,
    )
  })

  it('isValidContext checks the id grammar', () => {
    expect(isValidContext({ traceId: TRACE, spanId: SPAN, flags: 0 })).toBe(true)
    expect(isValidContext({ traceId: '0'.repeat(32), spanId: SPAN, flags: 0 })).toBe(false)
    expect(isValidContext({ traceId: TRACE, spanId: 'xyz', flags: 0 })).toBe(false)
    expect(isValidContext(null)).toBe(false)
  })
})

describe('tracestate', () => {
  it('parses members in order, trimming optional whitespace and skipping empty members', () => {
    expect(parseTracestate('rojo=00f067aa0ba902b7, congo=t61rcWkgMzE ,, ')).toEqual([
      ['rojo', '00f067aa0ba902b7'],
      ['congo', 't61rcWkgMzE'],
    ])
    expect(parseTracestate('')).toEqual([])
  })

  it('accepts the multi-tenant key form and printable values', () => {
    expect(parseTracestate('tenant@vendor=a b,x/y*z_1-2=!~')).toEqual([
      ['tenant@vendor', 'a b'],
      ['x/y*z_1-2', '!~'],
    ])
  })

  it('rejects bad keys, bad values, duplicates and more than 32 members', () => {
    expect(parseTracestate('Rojo=1')).toBeNull()
    expect(parseTracestate('_rojo=1')).toBeNull()
    expect(parseTracestate('rojo')).toBeNull()
    expect(parseTracestate('=1')).toBeNull()
    expect(parseTracestate('rojo=a=b')).toBeNull()
    expect(parseTracestate('rojo=')).toBeNull()
    expect(parseTracestate('rojo=é')).toBeNull()
    expect(parseTracestate('rojo=1,rojo=2')).toBeNull()
    expect(parseTracestate(`k=${'v'.repeat(257)}`)).toBeNull()

    const many = Array.from({ length: 33 }, (_, at) => `k${at}=v`).join(',')
    expect(parseTracestate(many)).toBeNull()
    expect(parseTracestate(many.split(',').slice(0, 32).join(','))).toHaveLength(32)
  })

  it('formats, reads and sets members (a set key moves to the front)', () => {
    expect(
      formatTracestate([
        ['a', '1'],
        ['b', '2'],
      ]),
    ).toBe('a=1,b=2')
    expect(formatTracestate([])).toBeUndefined()
    expect(getTracestate('a=1,ozaco=1', 'ozaco')).toBe('1')
    expect(getTracestate('a=1', 'ozaco')).toBeUndefined()
    expect(getTracestate(undefined, 'a')).toBeUndefined()

    expect(setTracestate('a=1,ozaco=0,b=2', 'ozaco', '1')).toBe('ozaco=1,a=1,b=2')
    expect(setTracestate(undefined, 'ozaco', '1')).toBe('ozaco=1')
    // an invalid key leaves the state alone; an invalid state is replaced
    expect(setTracestate('a=1', 'Bad', '1')).toBe('a=1')
    expect(setTracestate('A=1', 'ozaco', '1')).toBe('ozaco=1')

    const full = Array.from({ length: 32 }, (_, at) => `k${at}=v`).join(',')
    const set = setTracestate(full, 'ozaco', '1')!
    expect(set.split(',')).toHaveLength(32)
    expect(set.startsWith('ozaco=1,k0=v')).toBe(true)
    expect(set.includes('k31=v')).toBe(false)
  })
})

describe('extract', () => {
  it('reads traceparent and tracestate', () => {
    expect(extract(headers({ traceparent: VALID, tracestate: 'rojo=1,congo=2' }))).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      flags: 1,
      remote: true,
      state: 'rojo=1,congo=2',
    })
  })

  it('works over a Headers object (case-insensitive names)', () => {
    const inbound = new Headers({ TraceParent: VALID, TRACESTATE: 'rojo=1' })
    expect(extract(name => inbound.get(name))?.state).toBe('rojo=1')
  })

  it('treats duplicate traceparent headers as invalid', () => {
    expect(extract(headers({ traceparent: [VALID, VALID] }))).toBeNull()
    expect(extract(headers({ traceparent: [] }))).toBeNull()
    // `Headers.get` joins duplicates with ", " — invalid by length
    const inbound = new Headers()
    inbound.append('traceparent', VALID)
    inbound.append('traceparent', `00-${TRACE}-${'1'.repeat(16)}-01`)
    expect(extract(name => inbound.get(name))).toBeNull()
    expect(extract(headers({ traceparent: [VALID] }))?.spanId).toBe(SPAN)
  })

  it('joins several tracestate fields in order', () => {
    expect(extract(headers({ traceparent: VALID, tracestate: ['a=1,b=2', 'c=3'] }))?.state).toBe(
      'a=1,b=2,c=3',
    )
  })

  it('drops an invalid tracestate but keeps the context', () => {
    const context = extract(headers({ traceparent: VALID, tracestate: 'a=1,a=2' }))
    expect(context?.traceId).toBe(TRACE)
    expect(context?.state).toBeUndefined()
    expect(extract(headers({ traceparent: VALID, tracestate: '' }))?.state).toBeUndefined()
  })

  it('never parses tracestate without a valid traceparent', () => {
    let asked = false
    const context = extract(name => {
      if (name === 'tracestate') {
        asked = true
        return 'a=1'
      }
      return 'garbage'
    })
    expect(context).toBeNull()
    expect(asked).toBe(false)
  })

  it('returns null when there is nothing, and when the getter throws', () => {
    expect(extract(() => null)).toBeNull()
    expect(
      extract(() => {
        throw new Error('boom')
      }),
    ).toBeNull()
  })
})

describe('inject', () => {
  it('is empty without an active span', async () => {
    expect(unwrap(await run(() => inject()))).toEqual({})
  })

  it('forwards a pass-through context unchanged while tracing is off', async () => {
    const inbound = extract(headers({ traceparent: `00-${TRACE}-${SPAN}-02`, tracestate: 'x=1' }))!

    const carrier = unwrap(
      await run(() =>
        ActiveSpan.with(passThrough(inbound), function* () {
          // tracing is off: span() does not touch the active context
          return yield* span('ignored', () => inject({ ozaco: true }))
        }),
      ),
    )

    expect(carrier).toEqual({ traceparent: `00-${TRACE}-${SPAN}-02`, tracestate: 'x=1' })
  })

  it('injects the active recording span, marking ozaco callers on request', async () => {
    const { value } = await traced(function* () {
      return yield* span('call', function* (handle) {
        return {
          handle: handle.context,
          plain: yield* inject(),
          marked: yield* inject({ ozaco: true }),
        }
      })
    })

    expect(value.plain).toEqual({ traceparent: traceparentOf(value.handle) })
    expect(value.plain.traceparent?.endsWith('-03')).toBe(true)
    expect(value.marked.tracestate).toBe('ozaco=1')
  })

  it('carries the inbound tracestate through a continued trace', async () => {
    const inbound = extract(headers({ traceparent: VALID, tracestate: 'rojo=1' }))!

    const { value } = await traced(function* () {
      return yield* span('handler', { parent: inbound }, function* () {
        return yield* inject({ ozaco: true })
      })
    })

    expect(value.traceparent?.startsWith(`00-${TRACE}-`)).toBe(true)
    expect(value.traceparent?.includes(SPAN)).toBe(false)
    // inbound flags 01: no random bit came in, none goes out
    expect(value.traceparent?.endsWith('-01')).toBe(true)
    expect(value.tracestate).toBe('ozaco=1,rojo=1')
  })

  it('sends suppressed code unsampled (the random bit kept), and no ozaco mark', async () => {
    const { value } = await traced(function* () {
      return yield* span('call', () => suppressed(() => inject({ ozaco: true })))
    })

    // a trace id minted here carries the random bit: it stays, only the sampled bit clears
    expect(value.traceparent?.endsWith('-02')).toBe(true)
    expect(value.tracestate).toBeUndefined()
  })

  it('suppressed under an inbound context without the random bit sends flags 00', async () => {
    const { value } = await traced(function* () {
      return yield* span('call', { parent: parseTraceparent(`00-${TRACE}-${SPAN}-01`)! }, () =>
        suppressed(() => inject()),
      )
    })

    expect(value.traceparent?.startsWith(`00-${TRACE}-`)).toBe(true)
    expect(value.traceparent?.endsWith('-00')).toBe(true)
  })
})
