// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import { ACTION, SERVICE } from '../const'
import { define } from '../internal/service'
import type { EdgeDef } from '../types/edge'
import type { ServiceDef } from '../types/service'

/** A `service()` declaration (any module instance — the brand is a registered symbol). */
export const isService = (value: unknown): value is ServiceDef.Service =>
  typeof value === 'object' && value !== null && (value as { _t?: unknown })._t === SERVICE

/** A socket entry in an action map (`action.socket`). */
export const isSocketAction = (
  value: unknown,
): value is ServiceDef.SocketAction<AnyType, AnyType> =>
  typeof value === 'object' && value !== null && 'socket' in value

/**
 * Define an action: `action.query({ input, output, ...options }, function* ({ input, ctx }) {…})`.
 * The kind only fixes the default HTTP method, the manifest entry and the client behaviour —
 * `action(...)` alone is a plain `action` kind.
 */
export const action = Object.assign(define('action'), {
  query: define('query'),
  mutation: define('mutation'),
  action: define('action'),
  stream: define('stream'),

  /**
   * A socket INSIDE the service: `chat: action.socket({ protocol: 'chat' }, function* (socket)
   * {…})` mounts a WS route (default `/<service>/<action>`), listed under the service.
   *
   * Declare `receives` / `sends` and the handler is typed by them — inbound frames are validated
   * against `receives` before they reach `socket.messages`.
   */
  socket: <
    TReceives extends ServiceDef.Schema | undefined = undefined,
    TSends extends ServiceDef.Schema | undefined = undefined,
  >(
    config: ServiceDef.SocketConfig<TReceives, TSends>,
    handler: (
      socket: EdgeDef.Socket<ServiceDef.Frames<TReceives>, ServiceDef.Frames<TSends>>,
    ) => Operation<void>,
  ): ServiceDef.SocketAction<TReceives, TSends> => ({
    _t: ACTION,

    socket: {
      path: config.path ?? '',
      protocol: config.protocol ?? null,
      description: config.description ?? null,
      authorize: config.authorize ?? null,
      authorizeMode: config.authorizeMode ?? 'upgrade',
      defaults: config.defaults ?? null,
      receives: config.receives ?? null,
      sends: config.sends ?? null,
    },

    handler,
  }),
})

/** Define a service: a name and its actions. Routes default to `/<service>/<action>`; a
 * service-level `auth` becomes the option of every action that does not set its own. */
export const service = <const TName extends string, const TActions extends ServiceDef.ActionMap>(
  name: TName,
  actions: TActions,
  options?: ServiceDef.ServiceOptions,
): ServiceDef.Service<TName, TActions> => {
  const stamped = Object.fromEntries(
    Object.entries(actions).map(([key, def]) => {
      if (isSocketAction(def)) {
        return [
          key,
          def.socket.path === ''
            ? { ...def, socket: { ...def.socket, path: `/${name}/${key}` } }
            : def,
        ]
      }

      const route =
        def.meta.route.path === '' ? { ...def.meta.route, path: `/${name}/${key}` } : def.meta.route
      const inherits = options?.auth !== undefined && def.meta.options['auth'] === undefined
      const meta = inherits
        ? { ...def.meta, route, options: { ...def.meta.options, auth: options.auth } }
        : { ...def.meta, route }

      return [key, { ...def, meta }]
    }),
  ) as TActions

  return {
    _t: SERVICE,
    name,
    version: options?.version ?? '1.0.0',
    description: options?.description,
    actions: stamped,
  }
}

/** A typed reference to one action (what `ctx.call` takes); `server.api` builds these. */
export const ref = <A extends ServiceDef.Action>(
  serviceName: string,
  actionName: string,
): ServiceDef.Ref<A> => ({ service: serviceName, action: actionName })

/**
 * Every callable action of a service, as typed refs — from a TYPE-ONLY import:
 *
 *   import type { todos } from './todos'          // no runtime edge, no import cycle
 *   const api = refs<typeof todos>('todos')       // the name is checked against the type
 *
 *   yield* ctx.call(api.list, {}, { inherit: true })
 *
 * `server.api.<service>.<action>` carries the same refs for callers outside a handler.
 */
export const refs = <S extends ServiceDef.Service>(name: S['name']): ServiceDef.Refs<S> =>
  new Proxy({} as ServiceDef.Refs<S>, {
    get: (_target, key) => (typeof key === 'string' ? { service: name, action: key } : undefined),
  })

export const isSchema = (value: unknown): value is StandardSchemaV1 =>
  typeof value === 'object' && value !== null && '~standard' in value
