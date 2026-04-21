import type { Operation } from 'std:effect'
import { useContext } from 'std:effect'

import { SelfContext } from '../const'
import type { Service } from '../types/service'

export function* useSelf(): Operation<Service> {
  return yield* useContext(SelfContext)
}
