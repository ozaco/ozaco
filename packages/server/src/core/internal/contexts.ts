import { createContext } from 'std:effect'

import type { Service } from '../types/service'

export const SelfContext = createContext<Service>('server:service:self')
