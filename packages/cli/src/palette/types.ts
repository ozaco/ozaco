import type { Operation } from 'std:effect'

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
    /** Force color on/off (default: the installed terminal's `color` capability). */
    color?: boolean | undefined
    /** Force unicode symbols on/off (default: the terminal's `unicode` capability). */
    unicode?: boolean | undefined
    colors?: Partial<Colors> | undefined
    symbols?: Partial<Symbols> | undefined
  }

  export interface Context {
    color: boolean
    unicode: boolean
    colors: Colors
    symbols: Symbols
  }

  export interface Actions {
    colors(): Operation<Colors>
    symbols(): Operation<Symbols>
  }
}

export interface DefinePaletteOptions extends PaletteDef.Options {
  name?: string
  version?: string
}
