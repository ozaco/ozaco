import { createContext } from 'std:effect'

import type { Service } from './types/service'

export const SERVICE = Symbol.for('server:service')
export const ACTION = Symbol.for('server:action')
export const ACTION_CONTEXT = Symbol.for('server:action:context')

export const SelfContext = createContext<Service>('server:service:self')
