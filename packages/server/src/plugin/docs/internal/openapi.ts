import { bodyChannel } from 'server:core'
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

interface UploadField {
  readonly name: string
  readonly required: boolean
  readonly multiple: boolean
}

interface UploadSpec {
  readonly fields: readonly UploadField[]
  readonly openFields: boolean
}

const extractPathParams = (path: string): { openapiPath: string; params: string[] } => {
  const params: string[] = []
  const openapiPath = path.replaceAll(/:([A-Za-z_][A-Za-z0-9_]*)/gu, (_, name: string) => {
    params.push(name)
    return `{${name}}`
  })
  return { openapiPath, params }
}

const toJsonSchema = (schema: unknown, io: 'input' | 'output'): DocsDef.JsonSchema | undefined => {
  if (!schema) {
    return undefined
  }
  try {
    return z.toJSONSchema(schema as AnyType, {
      unrepresentable: 'any',
      io,
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

const uploadSpec = (entry: DocsDef.CompiledEntry): UploadSpec | undefined => {
  const wizardUpload = (entry.meta as AnyType).wizard?.upload as { fields?: unknown } | undefined

  if (wizardUpload && Array.isArray(wizardUpload.fields)) {
    const fields = wizardUpload.fields.flatMap((field: AnyType) =>
      typeof field?.name === 'string'
        ? [
            {
              name: field.name,
              required: field.required !== false,
              multiple: field.multiple === true,
            },
          ]
        : [],
    )
    return { fields, openFields: false }
  }

  // No wizard metadata — the DECLARATION is the remaining authority: an action whose input carries
  // a multistream channel is a multipart route, with field names unknown to the contract.
  const accepts = (entry.meta as AnyType).wire?.accepts as readonly string[] | undefined
  if (accepts?.includes('multistream')) {
    return { fields: [], openFields: true }
  }

  return undefined
}

const multipartSchema = (
  input: DocsDef.JsonSchema | undefined,
  upload: UploadSpec,
): DocsDef.JsonSchema => {
  const properties = { ...input?.properties }
  const required = new Set(input?.required)

  for (const field of upload.fields) {
    const file = { type: 'string', format: 'binary' }
    properties[field.name] = field.multiple ? { type: 'array', items: file } : file
    if (field.required) {
      required.add(field.name)
    }
  }

  return {
    ...input,
    type: 'object',
    properties,
    ...(required.size > 0 ? { required: [...required] } : {}),
    ...(upload.openFields ? { additionalProperties: true } : {}),
  }
}

const buildOperation = (
  entry: DocsDef.CompiledEntry,
  pathParams: string[],
): DocsDef.OperationObject => {
  const { meta, method, service, key } = entry

  // The RESOLVED wire, not the raw declaration: an input written as channels — e.g.
  // `[value(z.object({...})), parts()]` — is not a zod schema, and feeding it to z.toJSONSchema
  // silently collapses the documented body to an empty object. `bodyChannel` finds the one channel
  // whose schema IS the body contract, exactly as core validation reads it.
  const inputSchema = toJsonSchema(bodyChannel(meta.wire.input)?.schema ?? meta.input, 'input')
  const outputSchema = toJsonSchema(bodyChannel(meta.wire.output)?.schema ?? meta.output, 'output')

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

  const wizardKind = (meta as AnyType).wizard?.kind
  if (
    wizardKind === 'query' ||
    wizardKind === 'mutation' ||
    wizardKind === 'action' ||
    wizardKind === 'stream'
  ) {
    op['x-ozaco-kind'] = wizardKind
  }

  const wizardEmits = (meta as AnyType).wizard?.emits
  if (wizardEmits) {
    const emitsSchema = toJsonSchema(wizardEmits, 'output')
    if (emitsSchema) {
      op['x-ozaco-emits'] = emitsSchema
    }
  }

  const wizardRealtime = (meta as AnyType).wizard?.realtime
  if (wizardRealtime === 'websocket' || wizardRealtime === 'sse') {
    op['x-ozaco-realtime'] = wizardRealtime
  }

  const upload = uploadSpec(entry)

  if (meta.title) {
    op.summary = meta.title
  }
  if (meta.description) {
    op.description = meta.description
  }

  if (BODY_METHODS.has(method.toUpperCase()) && (inputSchema || upload)) {
    op.requestBody = {
      required: true,
      content: upload
        ? { 'multipart/form-data': { schema: multipartSchema(inputSchema, upload) } }
        : { 'application/json': { schema: inputSchema! } },
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
