import { ACTION, CHANNEL, SERVICE } from '../const'
import type { Action } from '../types/action'
import type { Channel, Schema } from '../types/channel'
import type { Service } from '../types/service'

export const isAction = (value: unknown): value is Action =>
  typeof value === 'function' && (value as { _t?: unknown })._t === ACTION

export const isService = (value: unknown): value is Service =>
  typeof value === 'object' && value !== null && (value as { _t?: unknown })._t === SERVICE

export const isChannel = (value: unknown): value is Channel =>
  typeof value === 'object' && value !== null && (value as { _t?: unknown })._t === CHANNEL

export const isSchema = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && '~standard' in value
