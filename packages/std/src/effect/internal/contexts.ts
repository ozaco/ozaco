import { createContext } from '../methods/context'
import type { Helpers } from '../types/helpers'
import type { Operation, Scope } from '../types/operation'

import { Reducer } from './reducer'
import { TaskGroup } from './task-group'

export const Routine = createContext<Helpers.Coroutine<unknown>>('std:effect:coroutine')

export const Priority = createContext<number>('std:effect:scope.generation', 0)

export const Children = createContext<Set<Scope>>('std:effect:scope.children')

export const ErrorContext = createContext<Helpers.ErrorBoundary>('std:effect:boundary', {
  raise: () => {},
})

export const SettleContext = createContext<Helpers.Settleware>(
  'std:effect:settle',
  (outcome, next) => next(outcome),
)

export const ReducerContext = createContext<Reducer>('std:effect:reducer', new Reducer())

export const TaskGroupContext = createContext<TaskGroup>('std:effect:task-group', new TaskGroup())

export const EachStack = createContext<Helpers.EachLoop<unknown>[]>('each')

export const ExitContext = createContext<(exit: Helpers.Exit) => Operation<void>>('exit')

export const DebugContext = createContext<((desc: string) => void) | 'force-silence'>(
  'std:effect:debug',
)
