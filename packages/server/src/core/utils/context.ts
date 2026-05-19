import { createContext } from 'std:effect'

import type { Action } from '../types/action'
import type { Service } from '../types/service'

export const ActionContext = createContext<Action>('server:core:action')
export const ServiceContext = createContext<Service>('server:core:service')
