import { NAMESPACE, PLUGIN } from '../const'
import type { Namespace, Plugin } from '../types/plugin'

export const isPlugin = (value: unknown): value is Plugin =>
  value !== null && typeof value === 'object' && '_t' in value && value._t === PLUGIN

export const isNamespace = (value: unknown): value is Namespace =>
  value !== null && typeof value === 'object' && '_t' in value && value._t === NAMESPACE
