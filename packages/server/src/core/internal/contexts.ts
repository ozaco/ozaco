import { createContext } from 'std:effect'

import type { ActionContext } from '../types/action'
import type { Service } from '../types/service'

export const SelfContext = createContext<Service>('server:service:self')
export const ActionContextRef = createContext<ActionContext<unknown>>('server:action:context')
