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

const rewriteRefs = (node: AnyType, refs: ReadonlyMap<string, string>): AnyType => {
  if (Array.isArray(node)) {
    return node.map(item => rewriteRefs(item, refs))
  }
  if (!node || typeof node !== 'object') {
    return node
  }
  const out: Record<string, AnyType> = {}
  for (const [key, value] of Object.entries(node)) {
    out[key] =
      key === '$ref' && typeof value === 'string' && refs.has(value)
        ? refs.get(value)
        : rewriteRefs(value, refs)
  }
  return out
}

// z.toJSONSchema emits recursive schemas (e.g. the wizard's mongo-style `filter`) as a root-level
// `$defs` map with internal `#/$defs/<name>` refs. Those fragments resolve against the OpenAPI
// DOCUMENT root — not the schema they sit in — so once the schema is re-rooted under a parameter
// or requestBody they dangle and Swagger UI errors. Hoist every def into `components.schemas`
// under a per-operation namespace and rewrite the refs to match.
const hoistDefs = (
  schema: DocsDef.JsonSchema | undefined,
  ns: string,
  shared: Record<string, DocsDef.JsonSchema>,
): DocsDef.JsonSchema | undefined => {
  const defs = schema?.$defs as Record<string, DocsDef.JsonSchema> | undefined
  if (!schema || !defs) {
    return schema
  }
  const refs = new Map(
    Object.keys(defs).map(name => [`#/$defs/${name}`, `#/components/schemas/${ns}.${name}`]),
  )
  for (const [name, def] of Object.entries(defs)) {
    shared[`${ns}.${name}`] = rewriteRefs(def, refs) as DocsDef.JsonSchema
  }
  const { $defs: _dropped, ...rest } = schema
  return rewriteRefs(rest, refs) as DocsDef.JsonSchema
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
  schemas: Record<string, DocsDef.JsonSchema>,
): DocsDef.OperationObject => {
  const { meta, method, service, key } = entry
  const ns = `${service}.${key}`.replaceAll(/[^A-Za-z0-9._-]/gu, '_')

  // The RESOLVED wire, not the raw declaration: an input written as channels — e.g.
  // `[value(z.object({...})), parts()]` — is not a zod schema, and feeding it to z.toJSONSchema
  // silently collapses the documented body to an empty object. `bodyChannel` finds the one channel
  // whose schema IS the body contract, exactly as core validation reads it.
  const inputSchema = hoistDefs(
    toJsonSchema(bodyChannel(meta.wire.input)?.schema ?? meta.input, 'input'),
    `${ns}.input`,
    schemas,
  )
  const outputSchema = hoistDefs(
    toJsonSchema(bodyChannel(meta.wire.output)?.schema ?? meta.output, 'output'),
    `${ns}.output`,
    schemas,
  )

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
    const emitsSchema = hoistDefs(toJsonSchema(wizardEmits, 'output'), `${ns}.emits`, schemas)
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
    // A `stream` route declares its args on the wizard lane, not as an `input`, because they travel
    // as ONE json-encoded `?args=` param instead of a field per param. Document that envelope
    // verbatim (OpenAPI's `content` form) so a generator can still recover the argument type.
    const wizardArgs = (meta as AnyType).wizard?.args
    const argsSchema = wizardArgs
      ? hoistDefs(toJsonSchema(wizardArgs, 'input'), `${ns}.args`, schemas)
      : undefined
    const all = [
      ...parameters,
      ...(argsSchema
        ? [
            {
              name: 'args',
              in: 'query' as const,
              content: { 'application/json': { schema: argsSchema } },
            },
          ]
        : pickQueryParams(inputSchema, pathParams)),
    ]
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

  const schemas: Record<string, DocsDef.JsonSchema> = {}

  for (const entry of entries) {
    const { openapiPath, params } = extractPathParams(entry.path)
    const pathItem = doc.paths[openapiPath] ?? {}

    // `ws` is not an OpenAPI method — writing it as a method entry made every spec consumer choke
    // on the document. A socket channel is represented as a vendor extension on the path item
    // instead: codegen reads the transport off `x-ozaco-realtime`, everyone else ignores it.
    if (entry.method === 'WS') {
      pathItem['x-ozaco-ws'] = {
        ...(entry.meta.title ? { summary: entry.meta.title } : {}),
        operationId: `${entry.service}.${entry.key}`,
        responses: {},
        'x-ozaco-realtime': (entry.meta as AnyType).wizard?.realtime ?? 'websocket',
      }
      doc.paths[openapiPath] = pathItem
      continue
    }

    const op = buildOperation(entry, params, schemas)
    if (docs.auth) {
      op.security = [{ [SECURITY_SCHEME_NAME]: [] }]
    }
    pathItem[entry.method.toLowerCase()] = op
    doc.paths[openapiPath] = pathItem
  }

  if (Object.keys(schemas).length > 0) {
    doc.components = { ...doc.components, schemas }
  }

  return doc
}
