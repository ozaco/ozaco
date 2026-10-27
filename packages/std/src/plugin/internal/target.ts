import type { Operation } from 'std:effect'
import { attempt, useContext } from 'std:effect'
import type { Result } from 'std:result'
import { fail, formatFailure, isFailure } from 'std:result'
import { validateSync } from 'std:schema'
import type { AnyType } from 'std:shared'

import { PluginErrors } from '../errors'
import type { Target } from '../types/target'

const DISCONNECTED: Target.Health = { ok: false, note: 'not connected' }
const INCOMPLETE: Target.Health = { ok: false, note: 'configuration incomplete' }

/** A failure's reason in its own words: the message, else its first cause, else a fixed line. */
const noteOf = (failure: Result.Failure<unknown>): string => {
  if (failure.message !== '') {
    return failure.message
  }

  const [cause] = failure.causes

  if (cause === undefined) {
    return 'no reason reported'
  }

  return typeof cause === 'string' ? cause : formatFailure(cause)
}

/**
 * `Protocol.target(options)`: an `implement` + `build` over a context of `{ bound, health, state }`.
 * The lifecycle actions are written here once; every domain action is wrapped so that it runs
 * only while bound and receives `{ config, secrets, state }` first — unbound, it fails
 * `std:plugin.not-connected` with the cause `<name>:disconnected`.
 */
export const buildTarget = (
  implement: (options: AnyType) => AnyType,
  options: Target.Options<AnyType, AnyType, AnyType, AnyType>,
): AnyType => {
  const impl = implement({
    name: options.name,
    version: options.version,
    description: options.description,
    *setup(): Operation<Target.Context<unknown, unknown, unknown>> {
      return { bound: null, health: DISCONNECTED, state: options.state?.() ?? {} }
    },
  })

  const held = function* (): Operation<Target.Held<unknown, unknown, unknown>> {
    const context: Target.Context<unknown, unknown, unknown> = yield* useContext(impl.context)

    if (context.bound === null) {
      return yield* fail(
        PluginErrors.NotConnected,
        `"${options.name}" is not connected`,
        `${options.name}:disconnected`,
      )
    }

    return { config: context.bound.config, secrets: context.bound.secrets, state: context.state }
  }

  const lifecycle: Target.Lifecycle = {
    *connect(bound) {
      const context: Target.Context<unknown, unknown, unknown> = yield* useContext(impl.context)
      const config = validateSync(options.config, bound.config)
      const secrets = validateSync(options.secrets, bound.secrets)

      if (isFailure(config) || isFailure(secrets)) {
        context.bound = null
        context.health = INCOMPLETE

        return context.health
      }

      const candidate = { config: config.value, secrets: secrets.value }
      const probed = yield* attempt(() => options.probe({ ...candidate, state: context.state }))

      if (isFailure(probed)) {
        context.bound = null
        context.health = { ok: false, note: noteOf(probed) }

        return context.health
      }

      context.bound = probed.value.ok ? candidate : null
      context.health = probed.value

      return context.health
    },

    *isConnected() {
      const context: Target.Context<unknown, unknown, unknown> = yield* useContext(impl.context)

      return context.health
    },

    *disconnect() {
      const context: Target.Context<unknown, unknown, unknown> = yield* useContext(impl.context)

      if (options.release) {
        yield* options.release(context.state)
      }

      context.bound = null
      context.health = DISCONNECTED
    },
  }

  const actions: Record<string, AnyType> = { ...lifecycle }

  for (const [key, action] of Object.entries(options.actions as Record<string, AnyType>)) {
    // the wrapper keeps the action's own properties (`getMeta` reads them)
    actions[key] = Object.assign(function* (...args: unknown[]) {
      return yield* action(yield* held(), ...args)
    }, action)
  }

  return impl.build(actions)
}
