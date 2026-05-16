import type { Operation } from 'std:effect'
import { createContext, useContext } from 'std:effect'

import type { Action } from '../types/action'
import type { Service } from '../types/service'

export const ActionContext = createContext<Action>('server:core:action')
export const ServiceContext = createContext<Service>('server:core:service')

// Hooks

export function* useAction<T = Action>(): Operation<T> {
  return (yield* useContext(ActionContext)) as T
}

export function* useService<T = Service>(): Operation<T> {
  return (yield* useContext(ServiceContext)) as T
}
