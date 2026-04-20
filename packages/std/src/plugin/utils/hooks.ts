// oxlint-disable oxc/no-rest-spread-properties

import type { Operation } from 'std:effect'
import { createContext, operation } from 'std:effect'
import { appendCauses, asFailure, fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import { flatten } from 'std:shared'

import { PLUGIN } from '../const'
import type { Helpers } from '../types/helpers'

const DEFAULT_STORE: Helpers.HookStore = {
  around: [],
  before: [],
  after: [],
  error: [],
  self: {},
}

const wrapAction = (action: Helpers.AnyAction, tag: string) =>
  operation(function* (...args: AnyType[]) {
    return yield* action(...args)
  }, tag)

export const createHookable = (options: {
  name: string
  version: string
  handlers?: Record<string, AnyType> | undefined
  defaultHandlers?: Record<string, AnyType> | undefined
  subtype?: symbol | undefined
}) => {
  const context = createContext(options.name)
  const hookCtx = createContext<Helpers.HookStore>(`${options.name}:hooks`, DEFAULT_STORE)
  const chainCtx = createContext<Map<string, unknown>>(`${options.name}:chain`)
  const namespaceTag = `${options.name}@${options.version ?? 'lts'}`

  const rootHandlers: Record<string, AnyType> = {}
  const defaultHandlers: Record<string, AnyType> = {}

  if (options.handlers) {
    for (const key of Object.keys(options.handlers)) {
      rootHandlers[key] = wrapAction(options.handlers[key]!, `${namespaceTag}#root`)
    }
  }

  if (options.defaultHandlers) {
    for (const key of Object.keys(options.defaultHandlers)) {
      defaultHandlers[key] = wrapAction(options.defaultHandlers[key]!, `${namespaceTag}#default`)
    }
  }

  const resolveAction = (key: string) =>
    operation(function* (...args: unknown[]) {
      return yield* chainCtx.with(new Map(), function* (): Operation<unknown> {
        const store = (yield* hookCtx.get()) ?? DEFAULT_STORE

        const arounds = store.around.flatMap(e => (key in e.handlers ? [e.handlers[key]] : []))
        const befores = store.before.flatMap(e => (key in e.handlers ? [e.handlers[key]] : []))
        const afters = store.after.flatMap(e => (key in e.handlers ? [e.handlers[key]] : []))
        const errors = store.error.flatMap(e => (key in e.handlers ? [e.handlers[key]] : []))
        const self = rootHandlers[key] ?? store.self[key] ?? (defaultHandlers as AnyType)[key]

        const inner = function* (...innerArgs: unknown[]) {
          for (const hook of befores) {
            yield* intercept(hook(innerArgs), `${key}:before`, namespaceTag)
          }

          if (!self) {
            return yield* fail(
              'unexpected',
              `No handler for "${key}" in "${options.name}", maybe forgot to install "${options.name}" plugin?`,
            )
          }
          let result: unknown = yield* intercept(self(...innerArgs))

          for (const hook of afters) {
            const modified = yield* intercept(hook(result, innerArgs), `${key}:after`, namespaceTag)
            if (modified !== undefined) {
              result = modified
            }
          }

          return result
        }

        const makeNext =
          (i: number) =>
          (...nextArgs: unknown[]): AnyType => ({
            *[Symbol.iterator]() {
              if (i < arounds.length) {
                return yield* intercept(arounds[i](nextArgs, makeNext(i + 1)))
              }
              return yield* intercept(inner(...nextArgs))
            },
          })

        try {
          if (arounds.length > 0) {
            return yield* intercept(arounds[0](args, makeNext(1)))
          }
          return yield* intercept(inner(...args))
        } catch (error) {
          if (errors.length > 0) {
            for (const hook of errors) {
              yield* intercept(hook(error, args))
            }
          }
          throw error
        }
      })
    })

  const createProxy = (prefix: string): AnyType => {
    const invoke = (...args: unknown[]) => resolveAction(prefix)(...args)

    return new Proxy(invoke, {
      get(_, key: string | symbol) {
        if (typeof key === 'symbol' || key === 'then') {
          return undefined
        }
        return createProxy(prefix ? `${prefix}.${key}` : key)
      },
      apply(_, __, args: unknown[]) {
        return invoke(...args)
      },
    })
  }

  const actions = createProxy('')

  const addHook = (type: 'around' | 'before' | 'after' | 'error') =>
    function* (handlers: Record<string, AnyType>) {
      const store = (yield* hookCtx.get()) ?? DEFAULT_STORE
      yield* hookCtx.set({
        ...store,
        [type]: [...store[type], { handlers: flatten(handlers) }],
      })
    }

  const hooks = {
    useHook: () => chainCtx.expect(),
    around: addHook('around'),
    before: addHook('before'),
    after: addHook('after'),
    error: addHook('error'),
  }

  const buildPlugin = (
    opts: {
      name: string
      version: string
      description?: string
      setup(...args: AnyType[]): Operation<unknown, unknown>
    },
    buildActions?: Record<string, Helpers.AnyAction>,
  ) => {
    const tag = `${opts.name}@${opts.version ?? 'lts'}`
    const handlers: Record<string, AnyType> = {}

    if (buildActions) {
      const flatActions = flatten(buildActions)
      for (const key of Object.keys(flatActions)) {
        handlers[key] = wrapAction(flatActions[key]!, tag)
      }
    }

    const rawSetup = opts.setup
    const setup =
      Object.keys(handlers).length > 0
        ? function* (...args: AnyType[]) {
            const value = yield* rawSetup(...args)
            const store = (yield* hookCtx.get()) ?? DEFAULT_STORE
            yield* hookCtx.set({ ...store, self: { ...store.self, ...handlers } })
            return value
          }
        : rawSetup

    const knownKeys = [...Object.keys(defaultHandlers), ...Object.keys(handlers)]

    return Object.freeze({
      _t: PLUGIN,
      ...(options.subtype ? { _st: options.subtype } : {}),

      name: opts.name,
      version: opts.version,
      description: opts.description,
      context,
      setup: operation(setup as AnyType, '#setup', tag),
      actions,
      getKeys: () => knownKeys,
      useHook: hooks.useHook,
      around: hooks.around,
      before: hooks.before,
      after: hooks.after,
      error: hooks.error,
    })
  }

  return { context, actions, hooks, buildPlugin }
}

export function* intercept(op: AnyType, ...causes: string[]): Operation<unknown> {
  const iter = op[Symbol.iterator]()
  let value: unknown
  let method: 'next' | 'throw' = 'next'

  while (true) {
    let step: IteratorResult<AnyType>

    try {
      step = method === 'next' ? iter.next(value) : iter.throw!(value)
    } catch (error) {
      const failure = asFailure(error)

      throw causes.length > 0 ? appendCauses(failure, ...causes) : failure
    }

    if (step.done) {
      return step.value
    }
    if (isFailure(step.value)) {
      throw causes.length > 0 ? appendCauses(step.value, ...causes) : step.value
    }

    try {
      value = yield step.value
      method = 'next'
    } catch (error) {
      value = error
      method = 'throw'
    }
  }
}
