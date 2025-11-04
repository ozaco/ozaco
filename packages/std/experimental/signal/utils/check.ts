import { SIGNAL } from '../const'
import type { Signal } from '../types'

export const isSignal = (value: unknown): value is Signal => {
  return typeof value === 'object' && value !== null && '_t' in value && value._t === SIGNAL
}
