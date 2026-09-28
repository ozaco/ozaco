// oxlint-disable import/exports-last
import { ACTION } from '../const'
import type { Helpers } from '../types/helpers'
import type { OptionsDef } from '../types/options'
import type { ServerDef } from '../types/server'
import type { ServiceDef } from '../types/service'
import { isPartsDecl, isStreamDecl } from '../utils/stream'

/** The STRUCTURAL config keys — everything else on a config is a plugin option. This tuple is
 * the single source: `metaOf` reads it at runtime, and the two compile-time checks below pin it
 * to `ServiceDef.Config` in BOTH directions, so a new structural field cannot silently leak
 * into `meta.options`. */
export const STRUCTURAL = [
  'title',
  'description',
  'input',
  'output',
  'route',
  'onDisconnect',
  'outcome',
  'errors',
  'tags',
  'docs',
  'status',
  'headers',
] as const

// every tuple member is a real structural key…
const _onlyStructural: readonly Helpers.StructuralKey[] = STRUCTURAL
// …and every structural key is in the tuple
const _allStructural: [Helpers.MissingStructural<typeof STRUCTURAL>] extends [never]
  ? true
  : Helpers.MissingStructural<typeof STRUCTURAL> = true

void [_onlyStructural, _allStructural]

export const RESERVED: ReadonlySet<string> = new Set(STRUCTURAL)

export const METHOD_OF: Readonly<Record<ServiceDef.Kind, ServiceDef.HttpMethod>> = {
  query: 'GET',
  mutation: 'POST',
  action: 'POST',
  stream: 'GET',
}

export const planeOf = (
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
export const metaOf = (kind: ServiceDef.Kind, config: ServiceDef.Config): ServiceDef.Meta => {
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
    docs: config.docs ?? null,
    status: config.status ?? null,
    headers: config.headers ?? {},
    options,
  }
}

export const define =
  (kind: ServiceDef.Kind) =>
  <
    TInput extends ServiceDef.Declaration | undefined = undefined,
    TOutput extends ServiceDef.Declaration | undefined = undefined,
    const TAuth extends OptionsDef.Requirement | undefined = undefined,
  >(
    // `auth` is captured so the handler's `ctx.auth` narrows: any truthy requirement means the
    // Auth plugin has verified a principal before the handler runs
    config: ServiceDef.Config<TInput, TOutput> & { readonly auth?: TAuth },
    handler: ServiceDef.Handler<
      ServiceDef.Params<TInput>,
      ServiceDef.Returns<TOutput>,
      ServerDef.Ctx<ServiceDef.AuthOf<TAuth>>
    >,
  ): ServiceDef.Action<TInput, TOutput, ServiceDef.AuthOf<TAuth>> => ({
    _t: ACTION,
    meta: metaOf(kind, config as ServiceDef.Config),
    handler,
  })
