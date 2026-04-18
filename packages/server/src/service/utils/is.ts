import { isPlugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { SERVICE } from '../const'
import type { Service } from '../types/service'

export const isService = (value: unknown): value is Service =>
  isPlugin(value) && (value as AnyType)._st === SERVICE
