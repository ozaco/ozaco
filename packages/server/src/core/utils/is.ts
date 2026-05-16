import { isPlugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { ACTION, SERVICE } from '../const'
import type { Action } from '../types/action'
import type { Service } from '../types/service'

export const isService = (value: unknown): value is Service =>
  isPlugin(value) && (value as AnyType)._st === SERVICE

export const isAction = (value: unknown): value is Action =>
  typeof value === 'function' && (value as AnyType)._t === ACTION
