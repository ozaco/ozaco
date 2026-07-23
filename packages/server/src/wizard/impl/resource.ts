import type { TableDef } from 'db:realtime'
import { Broker, defineService, Gateway } from 'server:core'

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
import { mountResourceRealtime, mountStreamRoute } from './realtime'
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
 *   row deltas. Add custom fns via `actions`, nest under a parent via `parent`.
 * - `resource(nameOrTable, module, options?)` bundles hand-written `query`/`mutation`/`action`/`stream`
 *   fns.
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

  const namespace = typeof targetOrName === 'string' ? targetOrName : targetOrName.name
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

  const service: Resource = defineService<unknown, [], ResourceActions<FnModule>>({
    name: namespace,
    version: '0.0.0',
    actions,
    *setup() {
      yield* Broker.actions.register(service)
      yield* Gateway.actions.mount(basePath, service)
      if (hasReactive) {
        yield* mountResourceRealtime({ basePath, namespace, module, transport })
        // Turn on cross-node reactive fan-out automatically when a Broker + realtime DB are present
        // (rides whatever transport is installed). Idempotent — attaches at most one bus per process.
        yield* ensureChangeBus()
      }
      for (const [name, definition] of streamEntries) {
        if (definition.rest) {
          yield* mountStreamRoute({ basePath, namespace, name, def: definition })
        }
      }
    },
  })

  return service
}
