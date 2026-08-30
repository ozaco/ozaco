import type { DocsDef } from '../types'

/** `{ error, message, causes, status }` — the edge's failure body. */
const FAILURE_SCHEMA = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
    causes: { type: 'array', items: { type: 'string' } },
    status: { type: 'number' },
  },
  required: ['error', 'message', 'causes', 'status'],
} as const

const BINARY_SCHEMA = { type: 'string', format: 'binary' } as const

/** A manifest schema as an OpenAPI one: opaque declarations become the empty (any) schema. */
const schemaOf = (schema: DocsDef.SchemaDoc | null): Record<string, unknown> =>
  schema === null || schema['declared'] === true ? {} : { ...schema }

const propertiesOf = (
  schema: DocsDef.SchemaDoc | null,
): { properties: Record<string, Record<string, unknown>>; required: readonly string[] } => {
  const resolved = schemaOf(schema)
  const properties = (resolved['properties'] ?? {}) as Record<string, Record<string, unknown>>
  const required = (resolved['required'] ?? []) as readonly string[]

  return { properties, required }
}

const pathParamsOf = (path: string): readonly string[] =>
  [...path.matchAll(/:([A-Za-z_]\w*)/gu)].map(match => match[1]!)

const parametersOf = (action: DocsDef.ActionDoc): Record<string, unknown>[] => {
  const params = pathParamsOf(action.route.path)
  const { properties } = propertiesOf(action.input.plane === 'value' ? action.input.schema : null)
  const parameters: Record<string, unknown>[] = params.map(name => ({
    name,
    in: 'path',
    required: true,
    schema: properties[name] ?? { type: 'string' },
  }))

  // a GET/HEAD value input travels as query parameters
  if (action.route.method === 'GET' && action.input.plane === 'value') {
    const { required } = propertiesOf(action.input.schema)

    for (const [name, schema] of Object.entries(properties)) {
      if (!params.includes(name)) {
        parameters.push({ name, in: 'query', required: required.includes(name), schema })
      }
    }
  }

  return parameters
}

const requestBodyOf = (action: DocsDef.ActionDoc): Record<string, unknown> | null => {
  if (action.route.method === 'GET' || action.input.plane === 'none') {
    return null
  }

  if (action.input.plane === 'stream') {
    return {
      required: true,
      content: {
        [action.input.contentType ?? 'application/octet-stream']: { schema: BINARY_SCHEMA },
      },
    }
  }

  if (action.input.plane === 'parts') {
    const { properties, required } = propertiesOf(action.input.schema)
    const streams = Object.keys(action.input.streams ?? {})

    return {
      required: true,
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            properties: {
              ...properties,
              ...Object.fromEntries(streams.map(name => [name, BINARY_SCHEMA])),
            },
            required: [...required, ...streams],
          },
        },
      },
    }
  }

  return {
    required: true,
    content: { 'application/json': { schema: schemaOf(action.input.schema) } },
  }
}

const okResponseOf = (action: DocsDef.ActionDoc): Record<string, unknown> => {
  if (action.output.plane === 'none') {
    return { description: 'empty' }
  }

  if (action.output.plane === 'stream') {
    const contentType = action.output.contentType ?? 'application/octet-stream'
    const perChunk = action.output.schema ? schemaOf(action.output.schema) : BINARY_SCHEMA

    return {
      description: `a ${action.output.brand ?? 'byte'} stream`,
      content: { [contentType]: { schema: perChunk } },
    }
  }

  return {
    description: 'ok',
    content: { 'application/json': { schema: schemaOf(action.output.schema) } },
  }
}

const responsesOf = (action: DocsDef.ActionDoc): Record<string, unknown> => {
  const responses: Record<string, unknown> = { '200': okResponseOf(action) }
  const byStatus = new Map<number, string[]>()

  for (const [tag, status] of Object.entries(action.errors)) {
    byStatus.set(status, [...(byStatus.get(status) ?? []), tag])
  }

  for (const [status, tags] of [...byStatus.entries()].toSorted(([a], [b]) => a - b)) {
    responses[String(status)] = {
      description: tags.join(' · '),
      content: { 'application/json': { schema: FAILURE_SCHEMA } },
    }
  }

  return responses
}

const operationOf = (action: DocsDef.ActionDoc): Record<string, unknown> => {
  const parameters = parametersOf(action)
  const requestBody = requestBodyOf(action)

  return {
    operationId: action.id,
    tags: [action.service],
    // always name the operation: viewers label entries by summary and fall back to the
    // description otherwise, which makes the list inconsistent
    summary: action.title ?? action.id,
    ...(action.description === undefined ? {} : { description: action.description }),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(requestBody === null ? {} : { requestBody }),
    responses: responsesOf(action),
  }
}

/**
 * The manifest as an OpenAPI 3.1 document: every action becomes an operation under its route
 * (`:id` params as `{id}`), planes map to bodies/contents (`value` → JSON, `stream` → its
 * content type, `parts` → multipart), the error catalog to per-status failure responses.
 * Socket routes have no OpenAPI shape and are skipped.
 */
export const openapiOf = (manifest: DocsDef.Manifest): Record<string, unknown> => {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const service of manifest.services) {
    for (const action of service.actions) {
      // socket entries live in the manifest's unified list but have no OpenAPI shape
      if (action.kind === 'socket') {
        continue
      }

      const path = action.route.path.replaceAll(/:([A-Za-z_]\w*)/gu, '{$1}')
      paths[path] ??= {}
      paths[path][action.route.method.toLowerCase()] = operationOf(action)
    }
  }

  return {
    openapi: '3.1.0',
    info: { title: manifest.name, version: manifest.version },
    paths,
    tags: manifest.services.map(service => ({
      name: service.name,
      ...(service.description === undefined ? {} : { description: service.description }),
    })),
  }
}
