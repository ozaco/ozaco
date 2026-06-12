import { PLUGIN, PROTOCOL } from '../const'
import type { Plugin } from '../types/plugin'
import type { Protocol } from '../types/protocol'

export const isPlugin = (value: unknown): value is Plugin =>
  value !== null && typeof value === 'object' && '_t' in value && value._t === PLUGIN

export const isProtocol = (value: unknown): value is Protocol =>
  value !== null && typeof value === 'object' && '_t' in value && value._t === PROTOCOL
