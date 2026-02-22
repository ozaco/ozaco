import type { createColors } from './plugin'

export type InputTypes = string | number | boolean | null | undefined

export type Options = {
  enabled?: boolean
}

export type ColorPlugin = ReturnType<typeof createColors>
