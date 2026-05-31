import type { AnyType } from 'std:shared'

import { z } from 'zod'

import type { DocsDef } from '../types'

import { DEFAULT_AUTH, SECURITY_SCHEME_NAME } from './const'

const buildSecurityScheme = (auth: DocsDef.AuthOptions): DocsDef.SecurityScheme => {
  const type = auth.type ?? 'bearer'

  const scheme: DocsDef.SecurityScheme =
    type === 'apiKey'
      ? {
          type: 'apiKey',
          name: auth.name ?? 'Authorization',
          in: auth.in ?? 'header',
        }
      : { type: 'http', scheme: type === 'basic' ? 'basic' : 'bearer' }

  if (type === 'bearer' && auth.bearerFormat) {
    scheme.bearerFormat = auth.bearerFormat
  }
  if (auth.description) {
    scheme.description = auth.description
  }

  return scheme
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

const extractPathParams = (path: string): { openapiPath: string; params: string[] } => {
  const params: string[] = []
  const openapiPath = path.replaceAll(/:([A-Za-z_][A-Za-z0-9_]*)/gu, (_, name: string) => {
    params.push(name)
    return `{${name}}`
  })
  return { openapiPath, params }
}

const toJsonSchema = (schema: unknown): DocsDef.JsonSchema | undefined => {
  if (!schema) {
    return undefined
  }
  try {
    return z.toJSONSchema(schema as AnyType, {
      unrepresentable: 'any',
      io: 'input',
    }) as DocsDef.JsonSchema
  } catch {
    // schema is not zod-representable; skip emitting a body/query schema
    return undefined
  }
}

const pickQueryParams = (
  jsonSchema: DocsDef.JsonSchema | undefined,
  pathParams: string[],
): DocsDef.ParameterObject[] => {
  if (!jsonSchema?.properties) {
    return []
  }
  const required = new Set(jsonSchema.required)
  const out: DocsDef.ParameterObject[] = []
  for (const [name, propSchema] of Object.entries(jsonSchema.properties)) {
    if (pathParams.includes(name)) {
      continue
    }
    out.push({
      name,
      in: 'query',
      required: required.has(name),
      schema: propSchema as DocsDef.JsonSchema,
    })
  }
  return out
}

const buildOperation = (
  entry: DocsDef.CompiledEntry,
  pathParams: string[],
): DocsDef.OperationObject => {
  const { meta, method, service, key } = entry

  const inputSchema = toJsonSchema(meta.input)
  const outputSchema = toJsonSchema(meta.output)

  const parameters: DocsDef.ParameterObject[] = pathParams.map(name => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }))

  const op: DocsDef.OperationObject = {
    tags: [service],
    operationId: `${service}.${key}`,
    responses: {
      '200': {
        description: 'Success',
        ...(outputSchema ? { content: { 'application/json': { schema: outputSchema } } } : {}),
      },
      '500': { description: 'Failure' },
    },
  }

  if (meta.title) {
    op.summary = meta.title
  }
  if (meta.description) {
    op.description = meta.description
  }

  if (BODY_METHODS.has(method.toUpperCase()) && inputSchema) {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: inputSchema } },
    }
    if (parameters.length > 0) {
      op.parameters = parameters
    }
  } else {
    const all = [...parameters, ...pickQueryParams(inputSchema, pathParams)]
    if (all.length > 0) {
      op.parameters = all
    }
  }

  return op
}

export const normalizeAuth = (auth: DocsDef.Options['auth']): DocsDef.AuthOptions | null => {
  if (!auth) {
    return null
  }
  if (auth === true) {
    return { ...DEFAULT_AUTH }
  }
  return { ...DEFAULT_AUTH, ...auth }
}

export const buildOpenAPISpec = (
  entries: DocsDef.CompiledEntry[],
  docs: DocsDef.Context,
): DocsDef.OpenAPIDocument => {
  const doc: DocsDef.OpenAPIDocument = {
    openapi: '3.1.0',
    info: {
      title: docs.title,
      version: docs.version,
      description: docs.description,
    },
    paths: {},
  }

  if (docs.auth) {
    doc.components = {
      securitySchemes: { [SECURITY_SCHEME_NAME]: buildSecurityScheme(docs.auth) },
    }
  }

  for (const entry of entries) {
    const { openapiPath, params } = extractPathParams(entry.path)
    const pathItem = doc.paths[openapiPath] ?? {}
    const op = buildOperation(entry, params)
    if (docs.auth) {
      op.security = [{ [SECURITY_SCHEME_NAME]: [] }]
    }
    pathItem[entry.method.toLowerCase()] = op
    doc.paths[openapiPath] = pathItem
  }

  return doc
}
