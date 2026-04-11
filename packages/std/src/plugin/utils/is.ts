import { PLUGIN } from '../const'
import type { Plugin } from '../types'

export const isPlugin = (value: unknown): value is Plugin =>
  value !== null && typeof value === 'object' && '_t' in value && value._t === PLUGIN
