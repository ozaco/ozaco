import { createContext } from 'std:effect'
import type { AnyType } from 'std:shared'

export const BunServerRef = createContext<AnyType>('server:bun:ref')
export const BunIsStartedRef = createContext<boolean>('server:bun:is-started')
export const BunIsPausedRef = createContext<false | string>('server:bun:is-paused')
