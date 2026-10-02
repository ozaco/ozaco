import { createColors, createSymbols, DefaultPalette } from 'cli:palette'
import { TerminalTracer } from 'cli:trace'
/**
 * The terminal tracer: a trace drawn as one timeline block through the `Terminal` — the tree, the
 * bars on a shared axis, markers and record lines, the palette's glyphs and colours — when its
 * root ends, when it goes idle, or when the tracer's scope closes.
 */
import type { Operation } from 'std:effect'
import { attempt, run, sleep } from 'std:effect'
import { fail, unwrap } from 'std:result'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { createMemoryScreen, MemoryTerminal } from 'cli:impl/memory'

import { renderBlock } from '../src/trace/internal/block'

const TRACE = `${'0'.repeat(31)}1`
const context = (spanId: string): TraceDef.SpanContext => ({ traceId: TRACE, spanId, flags: 1 })

const plain = (unicode: boolean) => ({
  color: false,
  unicode,
  colors: createColors(false),
  symbols: createSymbols(unicode),
})

/** A finished span: `[name, spanId, parentId]` over `[start, end]`. */
const spanData = (
  ids: [name: string, spanId: string, parent: string | null],
  range: [start: number, end: number],
  extra: Partial<TraceDef.SpanData> = {},
): TraceDef.SpanData => ({
  context: context(ids[1]),
  parent: ids[2] === null ? null : context(ids[2]),
  name: ids[0],
  kind: 'internal',
  service: 'demo',
  scope: { name: 'app' },
  start: range[0],
  end: range[1],
  attributes: {},
  droppedAttributes: 0,
  events: [],
  droppedEvents: 0,
  links: [],
  droppedLinks: 0,
  status: { code: 'unset' },
  ...extra,
})

const logData = (
  spanId: string,
  time: number,
  extra: Partial<TraceDef.LogData> = {},
): TraceDef.LogData => ({
  time,
  observedTime: time,
  severityNumber: 9,
  body: 'note',
  attributes: {},
  droppedAttributes: 0,
  context: context(spanId),
  service: 'demo',
  scope: { name: 'app' },
  ...extra,
})

/** Run `body` under a memory terminal (100 columns, ASCII, no colour) + palette + tracer;
 * resolves what reached the screen. */
const drawn = async (
  body: () => Operation<unknown>,
  options: { idleMs?: number; unicode?: boolean } = {},
): Promise<string> => {
  const screen = createMemoryScreen({
    columns: 100,
    capabilities: { interactive: false, unicode: options.unicode ?? false, color: 'none' },
  })

  unwrap(
    await run(function* () {
      yield* MemoryTerminal.use({ screen })
      yield* DefaultPalette.use()
      yield* TerminalTracer.use({ idleMs: options.idleMs })
      yield* body()
    }),
  )

  return screen.plain()
}

const REMOTE: TraceDef.SpanContext = { ...context('f'.repeat(16)), remote: true }

describe('cli — trace rendering', () => {
  it('draws the tree in order with bars on one axis, durations and outcomes', () => {
    const lines = renderBlock(
      {
        spans: [
          spanData(['db', '3', '2'], [4, 8], { kind: 'client', service: 'pg' }),
          spanData(['GET /todos', '1', null], [0, 20], { kind: 'server' }),
          spanData(['list', '2', '1'], [2, 12]),
          spanData(['notify', '4', '1'], [14, 18], {
            kind: 'client',
            attributes: { 'error.type': 'timeout' },
            status: { code: 'error', message: 'upstream timed out' },
          }),
        ],
        logs: [],
      },
      { width: 80, palette: plain(true) },
    )

    expect(lines[0]).toBe(
      `━━ GET /todos · demo · 4 spans · 20.00ms · 00:00:00.000 ${'━'.repeat(24)}`,
    )
    expect(lines[0]).toHaveLength(80)
    expect(lines.slice(1)).toEqual([
      'GET /todos   SERVER   ▕█████████████████████████████████████████████▏   20.00ms ok',
      '├─ list      INTERNAL ▕····███████████████████████··················▏   10.00ms ok',
      '│  └─ db @pg CLIENT   ▕·········█████████···························▏    4.00ms ok',
      '└─ notify    CLIENT   ▕·······························██████████····▏    4.00ms ✗ timeout: upstream timed out',
    ])
  })

  it('marks events and records on the bar and lists the records under their span', () => {
    const lines = renderBlock(
      {
        spans: [
          spanData(['root', '1', null], [0, 10], {
            events: [
              { name: 'step', time: 2 },
              { name: 'exception', time: 8 },
            ],
          }),
          spanData(['child', '2', '1'], [3, 4]),
        ],
        logs: [
          logData('1', 5, { body: 'half way' }),
          logData('1', 8, {
            severityNumber: 17,
            eventName: 'exception',
            body: 'app.boom: it broke\n    at step',
            attributes: { 'exception.type': 'app.boom' },
          }),
          logData('1', 1, { eventName: 'seen', body: 'seen', attributes: { user: 'ada' } }),
          logData('9', 3, { body: 'from a span that ended elsewhere' }),
        ],
      },
      { width: 60, palette: plain(true) },
    )

    expect(lines.slice(1)).toEqual([
      'root     INTERNAL ▕██◇██◆████████◇████████✖█████▏   10.00ms ok',
      '   ◇ +1.00ms INFO [seen] user=ada',
      '   ◇ +5.00ms INFO half way',
      '   ◇ +8.00ms ERROR [exception] app.boom: it broke',
      '         at step',
      '└─ child INTERNAL ▕········████·················▏    1.00ms ok',
      '   ◇ +3.00ms INFO from a span that ended elsewhere',
    ])
  })

  it('keeps the axis on the spans: a record stamped far later marks the edge, its offset stays', () => {
    const lines = renderBlock(
      {
        spans: [
          spanData(['report', '1', null], [0, 10], { events: [{ name: 'late', time: 5000 }] }),
          spanData(['publish', '2', '1'], [9, 10], { kind: 'producer' }),
        ],
        logs: [logData('1', 5000, { body: 'metrics' }), logData('1', -20, { body: 'before' })],
      },
      { width: 60, palette: plain(true) },
    )

    expect(lines[0]).toStartWith('━━ report · demo · 2 spans · 10.00ms ·')
    expect(lines[1]).toBe('report     INTERNAL ▕◇█████████████████████████◆▏   10.00ms ok')
    expect(lines[2]).toBe('   ◇ -20.00ms INFO before')
    expect(lines[3]).toBe('   ◇ +5000.00ms INFO metrics')
  })

  it('draws a one-span trace as one line, cuts a record line to the width', () => {
    const lines = renderBlock(
      {
        spans: [spanData(['WS /room', '1', null], [1000, 1002], { kind: 'server' })],
        logs: [logData('1', 1001, { body: `frame ${'x'.repeat(100)}` })],
      },
      { width: 60, palette: plain(true) },
    )

    expect(lines).toEqual([
      `▪ 00:00:01.000 WS /room @demo SERVER 2.00ms ok ${TRACE}`,
      `   ◇ +1.00ms INFO frame ${'x'.repeat(35)}…`,
    ])
    expect(lines[1]).toHaveLength(60)
  })

  it('falls back to ASCII glyphs on a terminal without unicode', () => {
    const lines = renderBlock(
      {
        spans: [
          spanData(['root', '1', null], [0, 4], { events: [{ name: 'exception', time: 3 }] }),
          spanData(['child', '2', '1'], [1, 2]),
        ],
        logs: [],
      },
      { width: 60, palette: plain(false) },
    )

    expect(lines).toEqual([
      `== root | demo | 2 spans | 4.00ms | 00:00:00.000 ${'='.repeat(11)}`,
      'root     INTERNAL [#####################X#######]    4.00ms ok',
      '`- child INTERNAL [.......########..............]    1.00ms ok',
    ])
  })

  it('takes the block service from the first span naming one, an edge root having none', () => {
    const lines = renderBlock(
      {
        spans: [
          spanData(['GET /x', '1', null], [0, 4], { kind: 'server', service: null }),
          spanData(['x.get', '2', '1'], [1, 3], { service: 'api' }),
          spanData(['find x', '3', '2'], [1, 2], { kind: 'client', service: 'api' }),
        ],
        logs: [],
      },
      { width: 60, palette: plain(true) },
    )

    expect(lines[0]).toStartWith('━━ GET /x · api · 3 spans')
    expect(lines.slice(1).map(line => line.slice(0, 12).trimEnd())).toEqual([
      'GET /x',
      '└─ x.get',
      '   └─ find x',
    ])
  })

  it('cuts a long label and keeps the bar at its minimum width', () => {
    const lines = renderBlock(
      {
        spans: [spanData(['a'.repeat(50), '1', null], [0, 1]), spanData(['b', '2', '1'], [0, 1])],
        logs: [],
      },
      { width: 40, palette: plain(true) },
    )

    expect(lines[1]).toBe(`${'a'.repeat(17)}… INTERNAL ▕████████████▏    1.00ms ok`)
  })
})

describe('cli — trace sink', () => {
  it('draws a block through the Terminal when the root span ends, the records inside it', async () => {
    const out = await drawn(() =>
      attempt(() =>
        Trace.actions.span('root', { kind: 'server', service: 'demo' }, function* () {
          yield* Trace.actions.event('auth.ok', { user: 'ada' })

          return yield* Trace.actions.span('child', { kind: 'client' }, function* () {
            return yield* fail('app.boom', 'it broke', 'step')
          })
        }),
      ),
    )

    const lines = out.trimEnd().split('\n')

    expect(lines).toHaveLength(6)
    expect(lines[0]).toMatch(/^== root \| demo \| 2 spans \| .* =+ [0-9a-f]{32}$/u)
    expect(lines[1]).toStartWith('root     SERVER   [')
    expect(lines[1]).toEndWith(' x app.boom: it broke')
    expect(lines[2]).toMatch(/^ {3}o \+\d+\.\d\dms INFO \[auth.ok\] user=ada$/u)
    expect(lines[3]).toStartWith('`- child CLIENT   [')
    expect(lines[4]).toMatch(/^ {6}o \+\d+\.\d\dms ERROR \[exception\] app.boom: it broke$/u)
    expect(lines[5]).toBe('            at step')
  })

  it('draws a trace without a root once it went idle, and again for what comes later', async () => {
    const out = await drawn(
      () =>
        attempt(function* () {
          yield* Trace.actions.span('first', { parent: REMOTE }, function* () {})
          yield* sleep(60)
          yield* Trace.actions.span('second', { parent: REMOTE }, function* () {})
          yield* sleep(60)
        }),
      { idleMs: 20 },
    )

    const names = out
      .split('\n')
      .filter(line => line.startsWith('- '))
      .map(line => line.split(' ')[2])

    expect(names).toEqual(['first', 'second'])
  })

  it('skips Logger-bridged records and prints a record outside every span at once', async () => {
    const out = await drawn(() =>
      attempt(function* () {
        yield* Trace.actions.emitLog({ body: 'bridged', severityNumber: 9, severityText: 'INFO' })
        yield* Trace.actions.emitLog({ body: 'stray', severityNumber: 13, scope: { name: 'app' } })
      }),
    )

    expect(out).toMatch(/^o \d\d:\d\d:\d\d\.\d{3} WARN app: stray\n$/u)
  })

  it('draws what is still collected when its scope closes', async () => {
    const out = await drawn(
      () => attempt(() => Trace.actions.span('late', { parent: REMOTE }, function* () {})),
      { idleMs: 10_000 },
    )

    expect(out).toMatch(/^- \d\d:\d\d:\d\d\.\d{3} late INTERNAL /u)
  })
})
