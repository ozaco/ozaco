import type { Operation } from 'std:effect'
import { useContext } from 'std:effect'

import { SelfContext } from '../internal/contexts'
import type { Service } from '../types/service'

export function* useSelf<T = Service>(): Operation<T> {
  return (yield* useContext(SelfContext)) as T
}
