import type { PaletteDef } from 'cli:core'

export type Env = Record<string, string | undefined>

export interface DetectInput {
  env: Env
  isTTY: boolean
}

export interface DefinePaletteOptions extends PaletteDef.Options {
  name?: string
  version?: string
}

export interface ResolveOptions {
  color?: boolean | undefined
  unicode?: boolean | undefined
  colors?: Partial<PaletteDef.Colors> | undefined
  symbols?: Partial<PaletteDef.Symbols> | undefined
}
