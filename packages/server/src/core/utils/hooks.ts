import type { Operation } from 'std:effect'
import { useContext } from 'std:effect'

import type { Action } from '../types/action'
import type { Service } from '../types/service'

import { ActionContext, ServiceContext } from './context'

export function* useAction<T = Action>(): Operation<T> {
  return (yield* useContext(ActionContext)) as T
}

export function* useService<T = Service>(): Operation<T> {
  return (yield* useContext(ServiceContext)) as T
}
