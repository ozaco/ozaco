import type { ColorLevel, Size, TerminalDef } from 'cli:core'
import { DEFAULT_COLUMNS, DEFAULT_ROWS } from 'cli:core'
import type { AnyType } from 'std:shared'

import type { Driver } from '../shared/types'

import type { Helpers } from './types/helpers'

const processOf = (): Helpers.Process | null =>
  (globalThis as { process?: Helpers.Process }).process ?? null

/**
 * How much color the terminal takes, read the way every tool reads it: an explicit `NO_COLOR`
 * or `FORCE_COLOR` wins, then `COLORTERM`, then `TERM`.
 */
const colorOf = (env: Record<string, string | undefined>, tty: boolean): ColorLevel => {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') {
    return 'none'
  }

  const forced = env['FORCE_COLOR']

  if (forced === '0') {
    return 'none'
  }

  if (forced !== undefined && forced !== '') {
    return forced === '1' ? '16' : forced === '2' ? '256' : 'true'
  }

  if (!tty || env['TERM'] === 'dumb') {
    return 'none'
  }

  const colorterm = env['COLORTERM'] ?? ''

  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) {
    return 'true'
  }

  return (env['TERM'] ?? '').includes('256') ? '256' : '16'
}

const unicodeOf = (env: Record<string, string | undefined>, platform: string): boolean => {
  if (platform === 'win32') {
    return env['WT_SESSION'] !== undefined || env['TERM_PROGRAM'] === 'vscode'
  }

  const locale = env['LC_ALL'] ?? env['LC_CTYPE'] ?? env['LANG'] ?? ''

  return /utf-?8/iu.test(locale)
}

/** Read the platform once: what this terminal is, and what it can do. */
export const detect = (
  overrides: Partial<TerminalDef.Capabilities> | undefined,
): Driver.Binding | null => {
  const runtime = processOf()

  if (!runtime) {
    return null
  }

  const { stdin, stdout, env } = runtime
  const platform = runtime.platform ?? ''
  const tty = Boolean(stdin.isTTY) && Boolean(stdout.isTTY)
  const rawMode = tty && typeof stdin.setRawMode === 'function'

  const capabilities: TerminalDef.Capabilities = {
    interactive: tty,
    color: colorOf(env, Boolean(stdout.isTTY)),
    unicode: unicodeOf(env, platform),
    rawMode,
    resize: Boolean(stdout.isTTY) && platform !== 'win32',
    altScreen: tty,
    ...overrides,
  }

  const handle: Driver.Handle = {
    write: text => {
      stdout.write(text)
    },

    size: (): Size => ({
      columns: stdout.columns ?? DEFAULT_COLUMNS,
      rows: stdout.rows ?? DEFAULT_ROWS,
    }),

    listen: onText => {
      const decoder = new TextDecoder()

      const onData = (chunk: AnyType): void => {
        const text =
          typeof chunk === 'string' ? chunk : decoder.decode(chunk as Uint8Array, { stream: true })

        if (text.length > 0) {
          onText(text)
        }
      }

      stdin.on('data', onData)
      stdin.resume?.()

      // never destroy stdin — the process keeps reading it after the session
      return () => {
        stdin.off('data', onData)
      }
    },

    raw: () => {
      if (!rawMode) {
        return () => {}
      }

      stdin.setRawMode?.(true)

      return () => {
        stdin.setRawMode?.(false)
      }
    },

    ...(capabilities.resize
      ? {
          onResize: (next: (size: Size) => void) => {
            const onWinch = (): void =>
              next({
                columns: stdout.columns ?? DEFAULT_COLUMNS,
                rows: stdout.rows ?? DEFAULT_ROWS,
              })

            runtime.on('SIGWINCH', onWinch)

            return () => {
              runtime.off('SIGWINCH', onWinch)
            }
          },
        }
      : {}),

    // in raw mode ctrl+c arrives as a KEY, not a signal — this covers the non-raw path
    onInterrupt: (next: () => void) => {
      runtime.on('SIGINT', next)

      return () => {
        runtime.off('SIGINT', next)
      }
    },
  }

  return { terminal: 'node', capabilities, handle }
}
