import { EVENT } from '../const'
import type { EventEmitter } from '../types'

export const isEvent = <Events extends Record<string, unknown> = Record<string, unknown>>(
  value: unknown,
): value is EventEmitter<Events> => {
  return typeof value === 'object' && value !== null && '_t' in value && value._t === EVENT
}
