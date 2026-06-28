import type { PaletteDef } from 'cli:core'
import { Palette, Terminal } from 'cli:core'
import { attempt, useContext } from 'std:effect'
import { IO } from 'std:io'
import { isSuccess } from 'std:result'

import { colorsAction, symbolsAction } from './internal/actions'
import type { DefinePaletteOptions, ResolveOptions } from './types'
import { createColors } from './utils/colors'
import { detectColor, detectUnicode } from './utils/detect'
import { createSymbols } from './utils/symbols'

const resolve = function* (options: ResolveOptions = {}) {
  const terminal = yield* attempt(useContext(Terminal))
  const isTTY = isSuccess(terminal) ? Boolean(terminal.value.output.isTTY) : false

  const detected = yield* IO.actions.env(env => ({
    color: detectColor({ env, isTTY }),
    unicode: detectUnicode({ env }),
  }))

  const color = options.color ?? detected.color
  const unicode = options.unicode ?? detected.unicode

  const colors: PaletteDef.Colors = { ...createColors(color), ...options.colors }
  const symbols: PaletteDef.Symbols = { ...createSymbols(unicode), ...options.symbols }

  return { color, unicode, colors, symbols }
}

export const definePalette = (definition: DefinePaletteOptions = {}): PaletteDef =>
  Palette.implement({
    name: definition.name ?? 'cli/custom-palette',
    version: definition.version ?? '0.0.0',
    *setup(options: PaletteDef.Options = {}) {
      return yield* resolve({
        color: options.color ?? definition.color,
        unicode: options.unicode ?? definition.unicode,
        colors: { ...definition.colors, ...options.colors },
        symbols: { ...definition.symbols, ...options.symbols },
      })
    },
  }).build({
    colors: colorsAction,
    symbols: symbolsAction,
  })

export const DefaultPalette = Palette.implement({
  name: 'cli/default-palette',
  version: '0.0.0',
  setup: resolve,
}).build({
  colors: colorsAction,
  symbols: symbolsAction,
})

export type { DefinePaletteOptions } from './types'
