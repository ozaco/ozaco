import type { ServerDef, ServiceDef } from 'server:core'
import { isPartsDecl, isSocketAction, isStreamDecl, STATUS_OF } from 'server:core'

import { z } from 'zod'

import type { DocsDef } from '../types'

const isZod = (value: unknown): value is z.ZodType =>
  typeof value === 'object' && value !== null && '_zod' in value

const schemaDoc = (schema: unknown): DocsDef.SchemaDoc | null => {
  if (!schema) {
    return null
  }

  if (isZod(schema)) {
    try {
      const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>
      const { $schema: _dropped, ...rest } = json

      return rest
    } catch {
      return { declared: true }
    }
  }

  return { declared: true }
}

const planeDoc = (
  declaration: ServiceDef.Declaration | null,
  plane: DocsDef.PlaneDoc['plane'],
): DocsDef.PlaneDoc => {
  if (!declaration) {
    return { plane: 'none', brand: null, contentType: null, schema: null }
  }

  if (isStreamDecl(declaration)) {
    return {
      plane: 'stream',
      brand: declaration.brand,
      contentType: declaration.spec.contentType,
      schema: schemaDoc(declaration.spec.schema),
    }
  }

  if (isPartsDecl(declaration)) {
    return {
      plane: 'parts',
      brand: 'parts',
      contentType: 'multipart/form-data',
      schema: schemaDoc(declaration.fields),

      streams: Object.fromEntries(
        Object.entries(declaration.streams).map(([name, decl]) => [name, decl.brand]),
      ),
    }
  }

  return {
    plane: plane === 'none' ? 'value' : plane,
    brand: null,
    contentType: 'application/json',
    schema: schemaDoc(declaration),
  }
}

/** Plugin options as JSON: functions (fallbacks) and undefineds dropped. */
const optionsDoc = (options: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify(options, (_key, value) => (typeof value === 'function' ? undefined : value)),
  )

/** One service as its manifest doc — also what the observe service's own manifest rides. */
export const serviceDocOf = (
  def: ServiceDef.Service,
  sockets: readonly DocsDef.SocketDoc[],
): DocsDef.ServiceDoc => {
  const actions: DocsDef.ActionDoc[] = []

  for (const [name, actionDef] of Object.entries(def.actions)) {
    if (isSocketAction(actionDef)) {
      continue
    }

    const { meta } = actionDef

    actions.push({
      id: `${def.name}.${name}`,
      service: def.name,
      action: name,
      kind: meta.kind,
      title: meta.title,
      description: meta.description,
      route: meta.route,
      input: planeDoc(meta.input, meta.inputPlane),
      output: planeDoc(meta.output, meta.outputPlane),
      errors: meta.errors,
      tags: meta.tags,
      options: optionsDoc(meta.options),
    })
  }

  return {
    name: def.name,
    version: def.version,
    description: def.description,
    actions,
    sockets,
  }
}

export const manifestOf = (
  kernel: ServerDef.Context,
  docs: { readonly path: string; readonly console: boolean },
): DocsDef.Manifest => {
  const services: DocsDef.ServiceDoc[] = []

  for (const def of kernel.registry.services.values()) {
    services.push(
      serviceDocOf(
        def,
        kernel.sockets.filter(socket => socket.service === def.name),
      ),
    )
  }

  return {
    manifest: 'ozaco/1',
    name: kernel.name,
    version: kernel.version,
    instance: kernel.instance,
    services,
    errors: STATUS_OF,
    sockets: [...kernel.sockets],
    observe: { console: docs.console ? '/_observe' : null },
    docs: { path: docs.path, openapi: `${docs.path}/openapi.json` },
  }
}
