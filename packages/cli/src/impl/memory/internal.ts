import type { TerminalDef } from 'cli:core'
import { stripAnsi } from 'cli:core'

import { decodeKeys } from '../shared/keys'
import type { Driver } from '../shared/types'

import type { Helpers } from './types/helpers'
import type { MemoryTerminalDef } from './types/memory'

const ESC = String.fromCodePoint(27)

/** Named keys → the bytes a real terminal would send. Anything unnamed is fed verbatim. */
const SEQUENCES: Readonly<Record<string, string>> = {
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  home: `${ESC}[H`,
  end: `${ESC}[F`,
  pageup: `${ESC}[5~`,
  pagedown: `${ESC}[6~`,
  delete: `${ESC}[3~`,
  insert: `${ESC}[2~`,
  enter: '\r',
  return: '\r',
  space: ' ',
  tab: '\t',
  backspace: String.fromCodePoint(127),
  escape: ESC,
  esc: ESC,
  'ctrl+c': String.fromCodePoint(3),
  'ctrl+d': String.fromCodePoint(4),
}

const CAPABILITIES: TerminalDef.Capabilities = {
  interactive: true,
  color: 'true',
  unicode: true,
  rawMode: true,
  resize: true,
  altScreen: true,
}

/** The fake screen plus the driver handle that reads it — one object, two faces. */
export const openScreen = (
  options: MemoryTerminalDef.ScreenOptions,
): {
  screen: MemoryTerminalDef.Screen
  handle: Driver.Handle
  capabilities: TerminalDef.Capabilities
} => {
  const capabilities: TerminalDef.Capabilities = { ...CAPABILITIES, ...options.capabilities }

  const state: Helpers.State = {
    written: '',
    size: { columns: options.columns ?? 80, rows: options.rows ?? 24 },
    raw: false,
    onText: null,
    onResize: null,
    onInterrupt: null,
    keys: [],
  }

  const feed = (text: string): void => {
    for (const key of decodeKeys(text)) {
      state.keys.push(key.name)
    }

    state.onText?.(text)
  }

  const screen: MemoryTerminalDef.Screen = {
    capabilities,
    feed,
    type: text => feed(text),

    press: (...keys) => {
      for (const key of keys) {
        feed(SEQUENCES[key] ?? key)
      }
    },

    interrupt: () => state.onInterrupt?.(),
    read: () => state.written,
    plain: () => stripAnsi(state.written),

    clear: () => {
      state.written = ''
    },

    setSize: size => {
      state.size = size
      state.onResize?.(size)
    },

    get raw() {
      return state.raw
    },

    get keys() {
      return [...state.keys]
    },
  }

  const handle: Driver.Handle = {
    write: text => {
      state.written += text
    },
    size: () => state.size,

    listen: onText => {
      state.onText = onText

      return () => {
        state.onText = null
      }
    },

    raw: () => {
      state.raw = true

      return () => {
        state.raw = false
      }
    },

    onResize: next => {
      state.onResize = next

      return () => {
        state.onResize = null
      }
    },

    onInterrupt: next => {
      state.onInterrupt = next

      return () => {
        state.onInterrupt = null
      }
    },
  }

  return { screen, handle, capabilities }
}
