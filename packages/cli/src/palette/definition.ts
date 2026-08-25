// oxlint-disable import/exports-last
import { Terminal } from 'cli:core'
import type { Operation } from 'std:effect'
import { defineProtocol } from 'std:plugin'

import pkg from '../../package.json'

import { colorsAction, symbolsAction } from './internal/actions'
import type { DefinePaletteOptions, PaletteDef } from './types'
import { createColors } from './utils/colors'
import { createSymbols } from './utils/symbols'

/**
 * The palette protocol: the shared color/symbol vocabulary every renderer (prompt, spinner, table,
 * command help) paints with. Defaults follow the installed terminal's detected capabilities; a
 * palette installed without a terminal degrades to plain ASCII, uncolored.
 */
export const Palette = defineProtocol<PaletteDef.Context, PaletteDef.Actions>({
  name: 'cli-palette',
  version: pkg.version,
  description: 'Shared cli color and symbol tables',
})

/** Resolve the installed palette context; install `DefaultPalette` (or a custom one) first. */
export const usePalette = (): Operation<PaletteDef.Context> => Palette.context.expect()

const resolve = function* (options: PaletteDef.Options = {}): Operation<PaletteDef.Context> {
  const info = yield* Terminal.context.get()

  const color = options.color ?? (info !== undefined && info.capabilities.color !== 'none')
  const unicode = options.unicode ?? info?.capabilities.unicode ?? false

  const colors: PaletteDef.Colors = { ...createColors(color), ...options.colors }
  const symbols: PaletteDef.Symbols = { ...createSymbols(unicode), ...options.symbols }

  return { color, unicode, colors, symbols }
}

/** Build a branded palette plugin with baked-in overrides (install-time options still win). */
export const definePalette = (definition: DefinePaletteOptions = {}) =>
  Palette.implement<PaletteDef.Context, [options?: PaletteDef.Options]>({
    name: definition.name ?? 'cli-custom-palette',
    version: definition.version ?? pkg.version,
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

export const DefaultPalette = Palette.implement<PaletteDef.Context, [options?: PaletteDef.Options]>(
  {
    name: 'cli-default-palette',
    version: pkg.version,
    description: 'Terminal-capability-driven palette',
    setup: resolve,
  },
).build({
  colors: colorsAction,
  symbols: symbolsAction,
})
