import { ensure } from 'std:effect'
import { definePlugin } from 'std:plugin'
import type { Plugin } from 'std:plugin'
import type { EmptyType } from 'std:shared'

import { Policy } from '../definition'
import type { PolicyEntry, PolicySpec } from '../types/policy'

/**
 * Creates a policy plugin. `install(SomePolicy, options)` registers the layer into the onion;
 * scope teardown unregisters it. Per-action overrides come from the action's typed
 * `policies: { [name]: options | false }` field — resolved by the router, no setting bags.
 */
export const definePolicy = <TOptions = void, TState = unknown>(
  spec: PolicySpec<TOptions, TState>,
): Plugin<{ readonly name: string; readonly state: TState }, [TOptions], EmptyType> =>
  definePlugin<{ readonly name: string; readonly state: TState }, [TOptions]>({
    name: `server/policy/${spec.name}`,
    version: spec.version ?? '0.1.0',
    *setup(options: TOptions) {
      const state = yield* spec.setup(options)

      const entry: PolicyEntry = {
        name: spec.name,
        priority: spec.priority,
        skipStreaming: spec.skipStreaming ?? false,
        apply: (ctx, next) => spec.apply({ ctx, state, override: ctx.overrides[spec.name], next }),
      }

      yield* Policy.actions.register(entry)

      yield* ensure(function* () {
        yield* Policy.actions.unregister(spec.name)

        if (spec.teardown) {
          yield* spec.teardown(state)
        }
      })

      return { name: spec.name, state }
    },
  }).build()
