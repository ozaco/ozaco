import { createContext } from '../base/context'
import type { Helpers } from '../types/helpers'
import type { Context, Operation, Scope } from '../types/operation'
import type { Utils } from '../types/utils'
import { createQueue } from '../utils/queue'

import { Reducer } from './reducer'

export const PriorityContext = createContext<number>('std:effect:scope.generation', 0)

export const ChildrenContext = createContext<Set<Scope>>('std:effect:scope.children')

// upstream defines these next to the coroutine/trap modules; they live here so the import graph
// stays acyclic — same defaults, same behavior
export const SettleContext = createContext<Helpers.Settleware>(
  'std:effect:coroutine.settle',
  (outcome, next) => next(outcome),
)

export const ErrorContext = createContext<Helpers.ErrorBoundary>('std:effect:error-boundary', {
  raise() {},
})

export const ReducerContext = createContext<Reducer>('std:effect:reducer', new Reducer())

export const ExitContext = createContext<(exit: Utils.Exit) => Operation<void>>('std:effect:exit')

export const EachStack = createContext<Helpers.EachLoop<unknown>[]>('std:effect:each')

/**
 * Context deciding which queue implementation backs each signal subscription — override to change
 * buffering behavior within a scope.
 */
export const SignalQueueFactoryContext: Context<typeof createQueue> = createContext(
  'std:effect:signal.createQueue',
  createQueue,
)
