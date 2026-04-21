import type { AnyType } from 'std:shared'

import { z } from 'zod'

import { SECURITY_SCHEME_NAME } from '../const'
import type { DocsContext } from '../types'

import { buildSecurityScheme } from './auth'
import type {
  CompiledEntry,
  JsonSchema,
  OpenAPIDocument,
  OperationObject,
  ParameterObject,
} from './types'

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

const extractPathParams = (path: string): { openapiPath: string; params: string[] } => {
  const params: string[] = []
  const openapiPath = path.replaceAll(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    params.push(name)
    return `{${name}}`
  })
  return { openapiPath, params }
}

const toJsonSchema = (schema: unknown): JsonSchema | undefined => {
  if (!schema) {
    return undefined
  }
  try {
    return z.toJSONSchema(schema as AnyType, {
      unrepresentable: 'any',
      io: 'input',
    }) as JsonSchema
  } catch {
    return undefined
  }
}

const pickQueryParams = (
  jsonSchema: JsonSchema | undefined,
  pathParams: string[],
): ParameterObject[] => {
  if (!jsonSchema?.properties) {
    return []
  }
  const required = new Set(jsonSchema.required)
  const out: ParameterObject[] = []
  for (const [name, propSchema] of Object.entries(jsonSchema.properties)) {
    if (pathParams.includes(name)) {
      continue
    }
    out.push({
      name,
      in: 'query',
      required: required.has(name),
      schema: propSchema as JsonSchema,
    })
  }
  return out
}

const buildOperation = (entry: CompiledEntry, pathParams: string[]): OperationObject => {
  const { meta, method, service, key } = entry

  const inputSchema = toJsonSchema(meta.input)
  const outputSchema = toJsonSchema(meta.output)

  const parameters: ParameterObject[] = pathParams.map(name => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }))

  const op: OperationObject = {
    tags: [service],
    operationId: `${service}.${key}`,
    responses: {
      '200': {
        description: 'Success',
        // oxlint-disable-next-line oxc/no-rest-spread-properties
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

export const buildOpenAPISpec = (entries: CompiledEntry[], docs: DocsContext): OpenAPIDocument => {
  const doc: OpenAPIDocument = {
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
