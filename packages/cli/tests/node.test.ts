/**
 * The Node/Bun binding's one piece of real logic: reading the platform. A tty check, the
 * NO_COLOR/FORCE_COLOR/COLORTERM/TERM ladder every tool honours, the locale for unicode, and the
 * signal wiring — all driven here through a fake `process`, so the assertions hold in CI where
 * there is no terminal at all.
 */
import type { AnyType } from 'std:shared'

import { afterEach, describe, expect, it } from 'bun:test'

import { detect } from '../src/impl/node/internal'

const real = (globalThis as AnyType).process

interface FakeOptions {
  readonly tty?: boolean
  readonly env?: Record<string, string | undefined>
  readonly platform?: string
}

const swap = (options: FakeOptions = {}): { written: string[]; signals: Set<string> } => {
  const tty = options.tty ?? true
  const written: string[] = []
  const signals = new Set<string>()

  ;(globalThis as AnyType).process = {
    stdin: {
      isTTY: tty,
      on: () => {},
      off: () => {},
      setRawMode: () => {},
      resume: () => {},
    },

    stdout: { isTTY: tty, columns: 120, rows: 40, write: (text: string) => written.push(text) },
    env: options.env ?? {},
    platform: options.platform ?? 'darwin',
    on: (event: string) => signals.add(event),
    off: (event: string) => signals.delete(event),
  }

  return { written, signals }
}

afterEach(() => {
  ;(globalThis as AnyType).process = real
})

describe('cli — node terminal', () => {
  it('reports an interactive tty with the size the stream carries', () => {
    const { written } = swap({ env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' } })
    const binding = detect(undefined)!

    expect(binding.terminal).toBe('node')
    expect(binding.capabilities).toMatchObject({
      interactive: true,
      color: '256',
      unicode: true,
      rawMode: true,
      resize: true,
    })

    expect(binding.handle.size()).toEqual({ columns: 120, rows: 40 })

    binding.handle.write('out')
    expect(written).toEqual(['out'])
  })

  it('walks the colour ladder the way every other tool does', () => {
    const level = (env: Record<string, string | undefined>, tty = true): string => {
      swap({ env, tty })
      return detect(undefined)!.capabilities.color
    }

    expect(level({ NO_COLOR: '1', COLORTERM: 'truecolor' })).toBe('none')
    expect(level({ FORCE_COLOR: '0' })).toBe('none')
    expect(level({ FORCE_COLOR: '1' })).toBe('16')
    expect(level({ FORCE_COLOR: '3' })).toBe('true')
    expect(level({ TERM: 'dumb' })).toBe('none')
    expect(level({ COLORTERM: 'truecolor' })).toBe('true')
    expect(level({ TERM: 'xterm-256color' })).toBe('256')
    expect(level({ TERM: 'xterm' })).toBe('16')

    // a pipe is not a terminal — no colour unless it was forced
    expect(level({ TERM: 'xterm-256color' }, false)).toBe('none')
    expect(level({ FORCE_COLOR: '2' }, false)).toBe('256')
  })

  it('reads unicode from the locale, and from the shell on windows', () => {
    const unicode = (env: Record<string, string | undefined>, platform = 'darwin'): boolean => {
      swap({ env, platform })
      return detect(undefined)!.capabilities.unicode
    }

    expect(unicode({ LANG: 'tr_TR.UTF-8' })).toBe(true)
    expect(unicode({ LC_ALL: 'C.utf8' })).toBe(true)
    expect(unicode({ LANG: 'C' })).toBe(false)
    expect(unicode({}, 'win32')).toBe(false)
    expect(unicode({ WT_SESSION: '1' }, 'win32')).toBe(true)
  })

  it('degrades on a pipe: not interactive, no raw mode, no resize', () => {
    swap({ tty: false, env: {} })
    const binding = detect(undefined)!

    expect(binding.capabilities).toMatchObject({
      interactive: false,
      rawMode: false,
      resize: false,
    })

    // raw() is a no-op that still hands back a restore, so callers need no branch
    expect(typeof binding.handle.raw()).toBe('function')
    expect(binding.handle.onResize).toBeUndefined()
  })

  it('lets an explicit capability override what was detected — the --no-color path', () => {
    swap({ env: { COLORTERM: 'truecolor' } })

    expect(detect({ color: 'none' })!.capabilities.color).toBe('none')
    expect(detect({ interactive: false })!.capabilities.interactive).toBe(false)
  })

  it('subscribes to SIGWINCH and SIGINT, and unsubscribes again', () => {
    const { signals } = swap({ env: {} })
    const binding = detect(undefined)!

    const stopResize = binding.handle.onResize!(() => {})
    expect(signals.has('SIGWINCH')).toBe(true)
    stopResize()
    expect(signals.has('SIGWINCH')).toBe(false)

    const stopInterrupt = binding.handle.onInterrupt!(() => {})
    expect(signals.has('SIGINT')).toBe(true)
    stopInterrupt()
    expect(signals.has('SIGINT')).toBe(false)
  })

  it('answers null where there is no process at all — a browser bundle', () => {
    ;(globalThis as AnyType).process = undefined
    expect(detect(undefined)).toBeNull()
  })
})
