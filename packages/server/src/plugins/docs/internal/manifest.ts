import type { EdgeDef, ServerDef, ServiceDef } from 'server:core'
import { STATUS_OF } from 'server:core'
import { isPartsDecl, isSocketAction, isStreamDecl } from 'server:internal'

import { z } from 'zod'

import type { DocsDef } from '../types'

const isZod = (value: unknown): value is z.ZodType =>
  typeof value === 'object' && value !== null && '_zod' in value

// input schemas are emitted by their INPUT side: a `.default()` field documents as optional
// (the server applies the default) — generated clients then match the wire truth
const schemaDoc = (schema: unknown, io: 'input' | 'output'): DocsDef.SchemaDoc | null => {
  if (!schema) {
    return null
  }

  if (isZod(schema)) {
    try {
      const json = z.toJSONSchema(schema, { unrepresentable: 'any', io }) as Record<string, unknown>
      const { $schema: _dropped, ...rest } = json

      return rest
    } catch {
      return { declared: true }
    }
  }

  return { declared: true }
}

// oxlint-disable-next-line max-params -- declaration · plane · schema side
const planeDoc = (
  declaration: ServiceDef.Declaration | null,
  plane: DocsDef.PlaneDoc['plane'],
  io: 'input' | 'output',
): DocsDef.PlaneDoc => {
  if (!declaration) {
    return { plane: 'none', brand: null, contentType: null, schema: null }
  }

  if (isStreamDecl(declaration)) {
    return {
      plane: 'stream',
      brand: declaration.brand,
      contentType: declaration.spec.contentType,
      schema: schemaDoc(declaration.spec.schema, io),
    }
  }

  if (isPartsDecl(declaration)) {
    return {
      plane: 'parts',
      brand: 'parts',
      contentType: 'multipart/form-data',
      schema: schemaDoc(declaration.fields, io),

      streams: Object.fromEntries(
        Object.entries(declaration.streams).map(([name, decl]) => [name, decl.brand]),
      ),
    }
  }

  return {
    plane: plane === 'none' ? 'value' : plane,
    brand: null,
    contentType: 'application/json',
    schema: schemaDoc(declaration, io),
  }
}

/** Plugin options as JSON: functions (fallbacks) and undefineds dropped. */
const optionsDoc = (options: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify(options, (_key, value) => (typeof value === 'function' ? undefined : value)),
  )

/** A mounted socket as the manifest publishes it: the frame schemas become JSON Schema. */
const socketDocOf = (socket: EdgeDef.SocketInfo): DocsDef.SocketDoc => ({
  path: socket.path,
  service: socket.service,
  protocol: socket.protocol,
  description: socket.description,
  defaults: socket.defaults,
  receives: schemaDoc(socket.receives, 'input'),
  sends: schemaDoc(socket.sends, 'output'),
})

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
      input: planeDoc(meta.input, meta.inputPlane, 'input'),
      output: planeDoc(meta.output, meta.outputPlane, 'output'),
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
        kernel.sockets.filter(socket => socket.service === def.name).map(socketDocOf),
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
    sockets: kernel.sockets.map(socketDocOf),
    observe: { console: docs.console ? '/_observe' : null },
    docs: { path: docs.path, openapi: `${docs.path}/openapi.json` },
  }
}
