// oxlint-disable import/exports-last
import {
  clientFrame,
  CoreStatusMap,
  normalizeDeclaration,
  serverFrame,
  valueSchemaOf,
} from 'server:core'
import type { ActionKind, ActionMeta, Declaration, Schema } from 'server:core'
import type { AnyType } from 'std:shared'

import { z } from 'zod'

import type { DocsAppInfo, DocsEntry, Manifest, ManifestFunction, ManifestService } from '../types'

/**
 * The OZACO MANIFEST v1 compiler. `buildManifest` compiles mounted services into the document;
 * the `manifestSchema` constant (in `../const`) validates it — a generated document that fails
 * the schema is a bug, never something to serve.
 */

/**
 * Standard Schema → JSON Schema document. Zod schemas convert via `z.toJSONSchema` (the `$schema`
 * marker is dropped — documents stay reference-free); any other Standard Schema vendor (and any
 * unrepresentable zod schema) stays opaque as `{ declared: true }`.
 */
export const schemaDocOf = (schema: Schema, io: 'input' | 'output'): Record<string, unknown> => {
  if (schema['~standard'].vendor !== 'zod') {
    return { declared: true }
  }

  try {
    const raw = z.toJSONSchema(schema as AnyType, { io }) as Record<string, unknown>

    return Object.fromEntries(Object.entries(raw).filter(([key]) => key !== '$schema'))
  } catch {
    return { declared: true }
  }
}

/** Mirrors the gateway's prefix-join so documented paths are the REAL mount paths. */
const joinPath = (prefix: string, path: string): string => {
  const cleanPrefix = prefix === '/' ? '' : prefix.replace(/\/$/u, '')
  const cleanPath = path.startsWith('/') ? path : `/${path}`

  if (cleanPath === '/') {
    return cleanPrefix === '' ? '/' : cleanPrefix
  }

  return `${cleanPrefix}${cleanPath}`
}

/** `meta.kind` wins; otherwise the route method infers it (GET/HEAD → query, else mutation). */
const kindOf = (meta: ActionMeta): ActionKind => {
  if (meta.kind) {
    return meta.kind
  }

  const method = meta.route?.method

  return method === 'GET' || method === 'HEAD' ? 'query' : 'mutation'
}

/** The documentable schema of a declaration: the value plane first, else any schema-typed plane. */
const declarationSchemaOf = (declaration: Declaration | undefined): Schema | undefined => {
  if (declaration === undefined) {
    return undefined
  }

  const channels = normalizeDeclaration(declaration)

  return valueSchemaOf(channels) ?? channels.find(channel => channel.schema !== undefined)?.schema
}

const statusMapOf = (errors: Record<string, number>): Record<string, { status: number }> =>
  Object.fromEntries(Object.entries(errors).map(([tag, status]) => [tag, { status }]))

const functionOf = (prefix: string, meta: ActionMeta): ManifestFunction => {
  const argsSchema = declarationSchemaOf(meta.input)
  const returnsSchema = declarationSchemaOf(meta.output)
  const tags = meta.docs?.tags

  return {
    kind: kindOf(meta),
    ...(meta.title === undefined ? {} : { title: meta.title }),
    ...(meta.description === undefined ? {} : { description: meta.description }),
    ...(meta.route === undefined
      ? {}
      : {
          route: {
            method: meta.route.method,
            path: joinPath(prefix, meta.route.path),
            ...(meta.route.sse === undefined ? {} : { sse: meta.route.sse }),
          },
        }),
    ...(argsSchema === undefined ? {} : { args: schemaDocOf(argsSchema, 'input') }),
    ...(returnsSchema === undefined ? {} : { returns: schemaDocOf(returnsSchema, 'output') }),
    channels: { input: [...meta.wire.input], output: [...meta.wire.output] },
    ...(Object.keys(meta.errors).length === 0 ? {} : { errors: statusMapOf(meta.errors) }),
    ...(tags === undefined || tags.length === 0 ? {} : { tags: [...tags] }),
  }
}

/** Frame variants of a discriminated union → `{ <discriminator value>: JSON Schema }`. */
const frameDocsOf = (
  variants: readonly AnyType[],
  spec: { readonly key: string; readonly io: 'input' | 'output' },
): Record<string, Record<string, unknown>> => {
  const docs: Record<string, Record<string, unknown>> = {}

  for (const variant of variants) {
    docs[String(variant.shape[spec.key].value)] = schemaDocOf(variant as Schema, spec.io)
  }

  return docs
}

/** The realtime frame vocabulary — computed once from the core frame schemas. */
const realtimeFrames = {
  client: frameDocsOf(clientFrame.options, { key: 'event', io: 'input' }),
  server: frameDocsOf(serverFrame.options, { key: 'type', io: 'output' }),
}

/**
 * The wizard SSE flavor marker: `resource()` compiles every table-backed resource a reserved
 * `realtime` action routed `GET /_realtime/sse` (`sse: true`), and `installWizard` mounts the
 * matching `<prefix>/_realtime` WebSocket route — the action's presence alone proves both
 * channels exist, with zero manual docs config.
 */
const hasSseFlavor = (entry: DocsEntry): boolean =>
  Object.values(entry.service.actions).some(
    action => action.meta.route?.sse === true && action.meta.route.path === '/_realtime/sse',
  )

/**
 * A service earns the realtime block when ANY of these hold: an action declares a `socket` wire
 * (classic hand-written realtime), the entry pins `realtimePath` explicitly, or the service is a
 * wizard-compiled table-backed resource (detected via {@link hasSseFlavor} — wizard actions never
 * declare socket wires; the WS route is mounted by `installWizard` itself). The `sse: true` flag
 * documents the `GET <path>/sse?fn=&args=&since=` flavor next to the WebSocket channel.
 */
const realtimeOf = (entry: DocsEntry): ManifestService['realtime'] => {
  const hasSocket = Object.values(entry.service.actions).some(
    action =>
      action.meta.wire.input.includes('socket') || action.meta.wire.output.includes('socket'),
  )
  const sse = hasSseFlavor(entry)

  if (!hasSocket && !sse && entry.realtimePath === undefined) {
    return undefined
  }

  return {
    path: entry.realtimePath ?? joinPath(entry.prefix, '/_realtime'),
    ...(sse ? { sse: true } : {}),
    client: {
      watch: realtimeFrames.client['watch'] ?? {},
      unwatch: realtimeFrames.client['unwatch'] ?? {},
    },
    server: {
      sync: realtimeFrames.server['sync'] ?? {},
      delta: realtimeFrames.server['delta'] ?? {},
      reset: realtimeFrames.server['reset'] ?? {},
      error: realtimeFrames.server['error'] ?? {},
    },
  }
}

const serviceOf = (entry: DocsEntry): ManifestService => {
  const functions: Record<string, ManifestFunction> = {}

  for (const [key, action] of Object.entries(entry.service.actions)) {
    functions[key] = functionOf(entry.prefix, action.meta)
  }

  const events: Record<string, Record<string, unknown>> = {}

  for (const [name, schema] of Object.entries(entry.service.events)) {
    events[name] = schemaDocOf(schema, 'output')
  }

  const realtime = realtimeOf(entry)

  return {
    version: entry.service.version,
    ...(entry.service.description === undefined ? {} : { description: entry.service.description }),
    prefix: entry.prefix,
    functions,
    ...(Object.keys(events).length === 0 ? {} : { events }),
    ...(realtime === undefined ? {} : { realtime }),
  }
}

/**
 * Compile mounted services into an OZACO MANIFEST v1 document. Pure — validation against
 * `manifestSchema` is the caller's gate (`Docs.actions.from` fails
 * `server:docs.invalid-manifest` on a mismatch).
 */
export const buildManifest = (app: DocsAppInfo, entries: readonly DocsEntry[]): Manifest => {
  const errors: Record<string, { status: number }> = statusMapOf(CoreStatusMap)
  const services: Manifest['services'] = {}

  for (const entry of entries) {
    services[entry.service.name] = serviceOf(entry)

    for (const action of Object.values(entry.service.actions)) {
      Object.assign(errors, statusMapOf(action.meta.errors))
    }
  }

  return {
    ozaco: '1.0',
    app: {
      title: app.title,
      version: app.version,
      ...(app.description === undefined ? {} : { description: app.description }),
    },
    ...(app.auth ? { auth: { bearer: true } } : {}),
    errors,
    services,
  }
}
