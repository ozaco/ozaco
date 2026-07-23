import type { AnyType } from 'std:shared'

import type {
  AccessGuard,
  ArgsOf,
  ArgsSpec,
  Command,
  FnKind,
  Mutation,
  Query,
  StreamDef,
  WizardActionConfig,
  WizardActionDef,
} from '../types'
import { composeAccess } from '../utils/access'

const defineAction = (kind: FnKind, config: AnyType): WizardActionDef => ({
  kind,
  target: config.target,
  args: config.args,
  returns: config.returns,
  emits: config.emits,
  reactive: config.reactive,
  access: config.access,
  watch: config.watch ?? (config.target ? [config.target] : '*'),
  rest: config.rest,
  upload: config.upload,
  handler: config.handler,
})

/** The base Wizard primitive. Prefer `query`, `mutation`, or `action` when the kind is static. */
export const defineWizard = (
  config: WizardActionConfig & { readonly type: FnKind },
): WizardActionDef => defineAction(config.type, config)

/** A read action. `args` types the handler `body` + call args; `returns` types the result. */
export const query = <A extends ArgsSpec | undefined = undefined, R = AnyType>(
  config: WizardActionConfig<A, R>,
): Query<ArgsOf<A>, R> => defineAction('query', config) as unknown as Query<ArgsOf<A>, R>

/** A write action. */
export const mutation = <A extends ArgsSpec | undefined = undefined, R = AnyType>(
  config: WizardActionConfig<A, R>,
): Mutation<ArgsOf<A>, R> => defineAction('mutation', config) as unknown as Mutation<ArgsOf<A>, R>

/** A non-reactive RPC action. */
export const action = <A extends ArgsSpec | undefined = undefined, R = AnyType>(
  config: WizardActionConfig<A, R>,
): Command<ArgsOf<A>, R> => defineAction('action', config) as unknown as Command<ArgsOf<A>, R>

/**
 * A producer-driven realtime endpoint whose payload is unrelated to a table write (metric ticks,
 * vitals, a log tail, build-step transitions). The `handler` returns a `Stream` (a `Subscription`) —
 * the realtime engine drains it and forwards each value, bounded to the socket's lifetime. `emits`
 * validates/documents the payload. Add a `rest: { method: 'GET', path }` to also serve it as a
 * dedicated SSE endpoint; otherwise it is reachable over the resource's `/<ns>/_realtime` channel.
 */
export const stream = <A extends ArgsSpec | undefined = undefined, R = AnyType>(
  config: WizardActionConfig<A, R>,
): StreamDef<ArgsOf<A>, R> => defineAction('stream', config) as unknown as StreamDef<ArgsOf<A>, R>

/** Bind a shared access guard once and compose it with any action-local guard. */
export const withAccess = (guard: AccessGuard) => ({
  query: <A extends ArgsSpec | undefined = undefined, R = AnyType>(
    config: WizardActionConfig<A, R>,
  ): Query<ArgsOf<A>, R> =>
    defineAction('query', {
      ...config,
      access: composeAccess(guard, config.access),
    }) as unknown as Query<ArgsOf<A>, R>,
  mutation: <A extends ArgsSpec | undefined = undefined, R = AnyType>(
    config: WizardActionConfig<A, R>,
  ): Mutation<ArgsOf<A>, R> =>
    defineAction('mutation', {
      ...config,
      access: composeAccess(guard, config.access),
    }) as unknown as Mutation<ArgsOf<A>, R>,
  action: <A extends ArgsSpec | undefined = undefined, R = AnyType>(
    config: WizardActionConfig<A, R>,
  ): Command<ArgsOf<A>, R> =>
    defineAction('action', {
      ...config,
      access: composeAccess(guard, config.access),
    }) as unknown as Command<ArgsOf<A>, R>,
  stream: <A extends ArgsSpec | undefined = undefined, R = AnyType>(
    config: WizardActionConfig<A, R>,
  ): StreamDef<ArgsOf<A>, R> =>
    defineAction('stream', {
      ...config,
      access: composeAccess(guard, config.access),
    }) as unknown as StreamDef<ArgsOf<A>, R>,
})
