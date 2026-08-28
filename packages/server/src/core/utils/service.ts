// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import { ACTION, SERVICE } from '../const'
import type { EdgeDef } from '../types/edge'
import type { ServerDef } from '../types/server'
import type { ServiceDef } from '../types/service'

import { isPartsDecl, isStreamDecl } from './stream'

const RESERVED = new Set([
  'title',
  'description',
  'input',
  'output',
  'route',
  'onDisconnect',
  'outcome',
  'errors',
  'tags',
])

const METHOD_OF: Readonly<Record<ServiceDef.Kind, ServiceDef.HttpMethod>> = {
  query: 'GET',
  mutation: 'POST',
  action: 'POST',
  stream: 'GET',
}

const planeOf = (
  declaration: ServiceDef.Declaration | undefined,
  side: 'input' | 'output',
): ServiceDef.Meta['inputPlane'] => {
  if (declaration === undefined) {
    return 'none'
  }

  if (isStreamDecl(declaration)) {
    return 'stream'
  }

  if (isPartsDecl(declaration)) {
    return side === 'input' ? 'parts' : 'value'
  }

  return 'value'
}

/** Resolve an action config into its meta once — the route is decided here (`/<service>/<action>`
 * unless given), the plugin options are collected under `options` for validation at
 * `createServer`. The service name is stamped in by `service()`. */
const metaOf = (kind: ServiceDef.Kind, config: ServiceDef.Config): ServiceDef.Meta => {
  const options: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(config)) {
    if (!RESERVED.has(key) && value !== undefined) {
      options[key] = value
    }
  }

  return {
    kind,
    title: config.title,
    description: config.description,
    input: config.input ?? null,
    output: config.output ?? null,
    inputPlane: planeOf(config.input, 'input'),
    outputPlane: planeOf(config.output, 'output') as ServiceDef.Meta['outputPlane'],
    route: config.route ?? { method: METHOD_OF[kind], path: '' },
    onDisconnect: config.onDisconnect ?? 'cancel',
    outcome: config.outcome ?? false,
    errors: config.errors ?? {},
    tags: config.tags ?? [],
    options,
  }
}

/** A socket entry in an action map (`action.socket`). */
export const isSocketAction = (value: unknown): value is ServiceDef.SocketAction =>
  typeof value === 'object' && value !== null && 'socket' in value

const define =
  (kind: ServiceDef.Kind) =>
  <
    TInput extends ServiceDef.Declaration | undefined = undefined,
    TOutput extends ServiceDef.Declaration | undefined = undefined,
  >(
    config: ServiceDef.Config<TInput, TOutput>,
    handler: ServiceDef.Handler<
      ServiceDef.Params<TInput>,
      ServiceDef.Returns<TOutput>,
      ServerDef.Ctx
    >,
  ): ServiceDef.Action<TInput, TOutput> => ({
    _t: ACTION,
    meta: metaOf(kind, config as ServiceDef.Config),
    handler: handler as AnyType,
  })

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
  ): ServiceDef.SocketAction => ({
    _t: ACTION,

    socket: {
      path: config.path ?? '',
      protocol: config.protocol ?? null,
      description: config.description ?? null,
      authorize: config.authorize ?? null,
      defaults: config.defaults ?? null,
      receives: config.receives ?? null,
      sends: config.sends ?? null,
    },

    handler: handler as AnyType,
  }),
})

/** Define a service: a name and its actions. Routes default to `/<service>/<action>`. */
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

      return [
        key,
        def.meta.route.path === ''
          ? { ...def, meta: { ...def.meta, route: { ...def.meta.route, path: `/${name}/${key}` } } }
          : def,
      ]
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
