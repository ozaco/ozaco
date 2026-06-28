import type { Future } from 'std:effect'
import type { Plugin } from 'std:plugin'

export type PaletteDef = Plugin<
  PaletteDef.Context,
  unknown,
  [options?: PaletteDef.Options],
  PaletteDef.Actions
>

export namespace PaletteDef {
  export type Style = (text: string) => string

  export interface Colors {
    primary: Style
    success: Style
    error: Style
    warning: Style
    info: Style
    muted: Style
    accent: Style

    bold: Style
    dim: Style
    underline: Style
    inverse: Style
    strikethrough: Style
  }

  export interface Symbols {
    question: string
    answered: string
    error: string
    warning: string
    info: string
    pointer: string
    separator: string
    checkboxOn: string
    checkboxOff: string
    barComplete: string
    barIncomplete: string
    spinner: readonly string[]
  }

  export interface Options {
    color?: boolean
    unicode?: boolean
    colors?: Partial<Colors>
    symbols?: Partial<Symbols>
  }

  export interface Context {
    color: boolean
    unicode: boolean
    colors: Colors
    symbols: Symbols
  }

  export interface Actions {
    colors(): Future<Colors, unknown>
    symbols(): Future<Symbols, unknown>
  }
}
