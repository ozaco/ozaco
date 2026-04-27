import { NatsTransport } from '..'
import type { NatsSetting } from '../types'

export const isNatsSetting = (value: unknown): value is NatsSetting =>
  typeof value === 'object' &&
  value !== null &&
  (value as { transport?: unknown }).transport === NatsTransport
