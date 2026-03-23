import { createContext } from '../methods/context'
import type { Helpers } from '../types/helpers'
import type { Scope } from '../types/operation'

export const Routine = createContext<Helpers.Coroutine<unknown>>('std:effect:coroutine')

export const Priority = createContext<number>('std:effect:scope.generation', 0)

export const Children = createContext<Set<Scope>>('std:effect:scope.children')
