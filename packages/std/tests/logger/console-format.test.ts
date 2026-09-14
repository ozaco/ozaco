import { run } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { LogLevel } from 'std:logger'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import {
  ANSI,
  colorOf,
  detectColor,
  formatBindings,
  labelOf,
  prettyFormat,
} from '../../src/logger/transport/console/internal'

const entry = (overrides: Partial<LoggerDef.Entry> = {}): LoggerDef.Entry => ({
  level: LogLevel.info,
  time: 0,
  msg: 'hello',
  error: '',
  bindings: {},
  data: undefined,
  ...overrides,
})

const withEnv = <T>(vars: Record<string, string | undefined>, body: () => T): T => {
  const previous = new Map(Object.keys(vars).map(key => [key, process.env[key]] as const))
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key)
    } else {
      process.env[key] = value
    }
  }
  try {
    return body()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('labelOf', () => {
  it('maps each level to a fixed-width (5 char) label', () => {
    expect(labelOf(LogLevel.trace)).toBe('TRACE')
    expect(labelOf(LogLevel.debug)).toBe('DEBUG')
    expect(labelOf(LogLevel.info)).toBe('INFO ')
    expect(labelOf(LogLevel.warn)).toBe('WARN ')
    expect(labelOf(LogLevel.error)).toBe('ERROR')
    expect(labelOf(LogLevel.fatal)).toBe('FATAL')

    for (const level of [
      LogLevel.trace,
      LogLevel.debug,
      LogLevel.info,
      LogLevel.warn,
      LogLevel.error,
      LogLevel.fatal,
    ]) {
      expect(labelOf(level)).toHaveLength(5)
    }
  })

  it('buckets by threshold: in-between and out-of-range levels fall to the nearest lower label', () => {
    expect(labelOf(35 as LogLevel)).toBe('INFO ')
    expect(labelOf(0 as LogLevel)).toBe('TRACE')
    expect(labelOf(999 as LogLevel)).toBe('FATAL')
  })
})

describe('colorOf', () => {
  it('maps each level to its ANSI color (fatal is bold magenta)', () => {
    expect(colorOf(LogLevel.trace)).toBe(ANSI.gray)
    expect(colorOf(LogLevel.debug)).toBe(ANSI.cyan)
    expect(colorOf(LogLevel.info)).toBe(ANSI.green)
    expect(colorOf(LogLevel.warn)).toBe(ANSI.yellow)
    expect(colorOf(LogLevel.error)).toBe(ANSI.red)
    expect(colorOf(LogLevel.fatal)).toBe(`${ANSI.bold}${ANSI.magenta}`)
  })

  it('buckets by threshold like labelOf', () => {
    expect(colorOf(45 as LogLevel)).toBe(ANSI.yellow)
    expect(colorOf(0 as LogLevel)).toBe(ANSI.gray)
  })
})

describe('detectColor', () => {
  it('NO_COLOR disables color and beats FORCE_COLOR', () => {
    expect(withEnv({ NO_COLOR: '1', FORCE_COLOR: undefined }, detectColor)).toBe(false)
    expect(withEnv({ NO_COLOR: '1', FORCE_COLOR: '1' }, detectColor)).toBe(false)
  })

  it('FORCE_COLOR enables color regardless of the TTY', () => {
    expect(withEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, detectColor)).toBe(true)
  })

  it('otherwise follows whether stdout is a TTY', () => {
    const expected = Boolean(process.stdout && process.stdout.isTTY)
    expect(withEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined }, detectColor)).toBe(expected)
  })
})

describe('formatBindings', () => {
  it('returns an empty string for no bindings', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()
      return yield* formatBindings({}, false)
    })

    expect(unwrap(outcome)).toBe('')
  })

  it('renders ` key=json` pairs, JSON-encoding each value', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()
      return yield* formatBindings({ req: 'abc', n: 1, nested: { a: [1] } }, false)
    })

    expect(unwrap(outcome)).toBe(' req="abc" n=1 nested={"a":[1]}')
  })

  it('paints only the key when color is on', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()
      return yield* formatBindings({ req: 'abc' }, true)
    })

    expect(unwrap(outcome)).toBe(` ${ANSI.cyan}req${ANSI.reset}="abc"`)
  })
})

describe('prettyFormat', () => {
  it('lays out `[iso-time] LABEL bindings: msg data err=…` without color', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()
      return {
        bare: yield* prettyFormat(entry(), false),
        full: yield* prettyFormat(
          entry({
            level: LogLevel.error,
            time: Date.UTC(2024, 0, 2, 3, 4, 5, 6),
            msg: 'request failed',
            bindings: { req: 'abc' },
            data: { status: 500 },
            error: 'boom: why',
          }),
          false,
        ),
      }
    })

    expect(unwrap(outcome)).toEqual({
      bare: '[1970-01-01T00:00:00.000Z] INFO : hello',
      full: '[2024-01-02T03:04:05.006Z] ERROR req="abc": request failed {"status":500} err="boom: why"',
    })
  })

  it('omits the data and error segments when absent', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()
      return yield* prettyFormat(entry({ level: LogLevel.warn, bindings: { a: 1 } }), false)
    })

    expect(unwrap(outcome)).toBe('[1970-01-01T00:00:00.000Z] WARN  a=1: hello')
  })

  it('paints the time dim, the label by level, and the error red when color is on', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()
      return yield* prettyFormat(entry({ level: LogLevel.error, error: 'boom' }), true)
    })

    expect(unwrap(outcome)).toBe(
      `${ANSI.dim}[1970-01-01T00:00:00.000Z]${ANSI.reset} ` +
        `${ANSI.red}ERROR${ANSI.reset}: hello ` +
        `${ANSI.red}err="boom"${ANSI.reset}`,
    )
  })

  it('is the ConsoleTransport default format only through the JSON codec (bindings/data need it)', async () => {
    // no JsonCodec installed: any entry with bindings/data/error fails missing-action instead of
    // silently rendering — pins that prettyFormat depends on the codec registry
    const outcome = await run(function* () {
      return yield* prettyFormat(entry({ bindings: { a: 1 } }), false)
    })

    expect(outcome).toMatchObject({ error: 'std:plugin.missing-action' })
  })
})
