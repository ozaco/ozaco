import { ansi } from 'cli:core'

import type { PaletteDef } from '../types'

const styler =
  (enabled: boolean) =>
  (open: number, close: number): PaletteDef.Style =>
    enabled ? text => `${ansi.esc}[${open}m${text}${ansi.esc}[${close}m` : text => text

export const createColors = (enabled: boolean): PaletteDef.Colors => {
  const style = styler(enabled)

  return {
    primary: style(36, 39),
    success: style(32, 39),
    error: style(31, 39),
    warning: style(33, 39),
    info: style(34, 39),
    muted: style(90, 39),
    accent: style(35, 39),

    bold: style(1, 22),
    dim: style(2, 22),
    underline: style(4, 24),
    inverse: style(7, 27),
    strikethrough: style(9, 29),
  }
}
