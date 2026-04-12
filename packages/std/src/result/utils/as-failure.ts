import type { AnyType } from 'std:shared'

import type { Impl } from '../types/impl'

import { fail } from './fail'
import { isFailure } from './is'

export const asFailure: Impl.AsFailure = (error: unknown) =>
  isFailure(error) ? error : (fail(error) as AnyType)
