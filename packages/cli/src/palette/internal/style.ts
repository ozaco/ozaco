import { ansi } from 'cli:core'

import type { PaletteDef } from '../types'

/** A style factory: `open`/`close` SGR codes around the text, or the identity when disabled. */
export const styler =
  (enabled: boolean) =>
  (open: number, close: number): PaletteDef.Style =>
    enabled ? text => `${ansi.esc}[${open}m${text}${ansi.esc}[${close}m` : text => text
