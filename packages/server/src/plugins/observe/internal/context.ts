import { createContext } from 'std:effect'

import type { ObservePluginDef } from '../types'

export const StateRef = createContext<ObservePluginDef.State>('server:plugins/observe')

export const DAY_MS = 24 * 60 * 60 * 1000
