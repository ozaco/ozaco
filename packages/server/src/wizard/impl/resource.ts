import type { TableDef } from 'db:realtime'
import { Broker, defineService, Gateway, useRole } from 'server:core'

import type {
  CrudModule,
  CrudResourceConfig,
  FnModule,
  Resource,
  ResourceOptions,
  ToAction,
} from '../types'
import { ensureChangeBus } from '../utils/change-bus'

import { buildCrudModule } from './crud'
import { realtimeAction, sseRealtimeAction, streamRouteAction } from './realtime'
import { buildResourceAction } from './resource-action'

/** Project a function module to the `.actions` record the Broker calls: each entry becomes the core
 * `Action` carrying that function's arg + result types, so `Broker.call` infers them. */
type ResourceActions<TModule extends FnModule> = {
  readonly [K in keyof TModule]: ToAction<TModule[K]>
}

const isCrudConfig = (value: FnModule | CrudResourceConfig): value is CrudResourceConfig =>
  (value as { type?: unknown }).type === 'crud'

/**
 * Bundle a table's or named group's functions into one native Service. Installing the resource
 * registers it with the Broker, mounts its REST routes on the Gateway, and (for any query/stream)
 * serves a `/<ns>/_realtime` channel.
 *
 * - `resource(table, { type: 'crud', ...opts })` generates the standard REST collection (spec §0.1):
 *   `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `PUT /:id`, `DELETE /:id`, `PATCH /batch`, plus live
 *   row deltas. Add custom fns via `actions`, nest under a parent via `parent`, and decouple the
 *   address from the storage name via `namespace` (table `appRoles` at `/app-roles`).
 * - `resource(nameOrTable, module, options?)` bundles hand-written `query`/`mutation`/`action`/`stream`
 *   fns.
 *
 * Nesting note: a mount claims its whole subtree, for every method. A child at `/kb/files` makes
 * `files` a reserved word in the parent's `:id` space symmetrically — `PATCH /kb/files` answers 404
 * rather than becoming `kb.update(id: 'files')` (the gateway router enforces this).
 */
export function resource<T extends TableDef, TActions extends FnModule = Record<never, never>>(
  target: T,
  config: CrudResourceConfig & { actions?: TActions },
): Resource<ResourceActions<CrudModule<T> & TActions>>
export function resource<TModule extends FnModule>(
  targetOrName: TableDef | string,
  module: TModule,
  options?: ResourceOptions,
): Resource<ResourceActions<TModule>>
export function resource(
  targetOrName: TableDef | string,
  moduleOrConfig: FnModule | CrudResourceConfig,
  options: ResourceOptions = {},
): Resource {
  const crud = isCrudConfig(moduleOrConfig)
  if (crud && typeof targetOrName === 'string') {
    throw new Error(
      "resource({ type: 'crud' }) requires a table definition, not a namespace string",
    )
  }
  if (
    crud &&
    moduleOrConfig.namespace !== undefined &&
    !/^[A-Za-z0-9][\w-]*$/u.test(moduleOrConfig.namespace)
  ) {
    throw new Error(
      `resource namespace "${moduleOrConfig.namespace}" must be one plain path segment ([A-Za-z0-9_-]) — nesting is what \`parent\` is for`,
    )
  }

  // The resource's IDENTITY: service name, role key and route segment together. The table's name is
  // only the DEFAULT — `namespace` frees the storage name from the address (`appRoles` at
  // `/app-roles`); the CRUD module keeps reading/writing the TABLE regardless.
  const namespace = crud
    ? (moduleOrConfig.namespace ?? (targetOrName as TableDef).name)
    : typeof targetOrName === 'string'
      ? targetOrName
      : targetOrName.name
  const module: FnModule = crud
    ? (buildCrudModule(targetOrName as TableDef, moduleOrConfig) as unknown as FnModule)
    : moduleOrConfig
  const transport = (crud ? moduleOrConfig.realtime : options.realtime) ?? 'websocket'
  const parent = crud ? moduleOrConfig.parent : options.parent
  const basePath = parent ? `${parent}/${namespace}` : `/${namespace}`

  // `stream` actions are not REST-routed; they are served over `_realtime` (and their own SSE route).
  const restModule = Object.fromEntries(
    Object.entries(module).filter(([, definition]) => definition.kind !== 'stream'),
  )
  const streamEntries = Object.entries(module).filter(([, def]) => def.kind === 'stream')
  const hasReactive = Object.values(module).some(
    definition => definition.kind === 'query' || definition.kind === 'stream',
  )

  const actions = Object.fromEntries(
    Object.entries(restModule).map(([name, definition]) => [
      name,
      buildResourceAction({
        namespace,
        name,
        definition,
        realtime: hasReactive ? transport : undefined,
      }),
    ]),
  ) as unknown as ResourceActions<FnModule>

  /**
   * The realtime surface as ROUTES ON THE SERVICE, not gateway-local endpoints. `_realtime` is a
   * session-mode socket (or its one-way SSE flavour) and every rest-routed `stream` fn is an SSE
   * action — so the one `Gateway.mount` below routes the entire surface, and a gateway with NO
   * database can serve it: the pumps run next to the DB on whichever pod owns the resource.
   */
  const channels: Record<string, unknown> = {}
  if (hasReactive) {
    channels._realtime =
      transport === 'sse' ? sseRealtimeAction(namespace, module) : realtimeAction(namespace, module)
  }
  for (const [name, definition] of streamEntries) {
    if (definition.rest) {
      channels[name] = streamRouteAction(namespace, name, definition)
    }
  }
  Object.assign(actions, channels)

  const service: Resource = defineService<unknown, [], ResourceActions<FnModule>>({
    name: namespace,
    version: '0.0.0',
    actions,
    *setup() {
      /**
       * The resource is the ONE authority on its own wiring, and the ROLE decides how much of it
       * this process gets. Without an orchestrator that is the classic pair (own + serve when a
       * gateway exists); under a daemon, `SERVICE=notes` makes the notes pod register-only and the
       * gateway mount-only — including the realtime channel and stream routes, which a daemon's
       * generic module wiring knows nothing about. Registering unconditionally was how a GATEWAY
       * replica used to claim ownership of every resource it merely served. (A daemon module that
       * lists this resource still works: `register` is idempotent for the same object, and the
       * module needs no `route` — the resource mounts its own paths.)
       */
      const { own, serve } = yield* useRole(namespace)

      if (own) {
        yield* Broker.actions.register(service)
      }

      if (serve) {
        // one mount routes EVERYTHING — CRUD, `_realtime` (session WS or SSE), stream routes
        yield* Gateway.actions.mount(basePath, service)
      }

      if ((own || serve) && hasReactive) {
        // Cross-node reactive fan-out (rides whatever transport is installed): the OWNER publishes
        // change events, a SERVING process relays them — both need the bus. Idempotent per process.
        yield* ensureChangeBus()
      }
    },
  })

  return service
}
