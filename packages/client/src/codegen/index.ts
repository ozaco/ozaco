import type { ManualOperation } from 'std:effect'
import { operation, until } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

type FnKind = 'query' | 'mutation' | 'action' | 'stream'

interface OpenAPIMedia {
  readonly schema?: AnyType
}

interface OpenAPIOperation {
  readonly operationId?: string
  readonly parameters?: readonly {
    readonly name: string
    readonly required?: boolean
    readonly schema?: AnyType
  }[]
  readonly requestBody?: {
    readonly content?: Record<string, OpenAPIMedia>
  }
  readonly responses?: Record<string, { readonly content?: Record<string, OpenAPIMedia> }>
  readonly 'x-ozaco-kind'?: FnKind
  readonly 'x-ozaco-emits'?: AnyType
  readonly 'x-ozaco-realtime'?: 'websocket' | 'sse'
}

interface OpenAPIDocument {
  readonly paths: Record<string, Record<string, OpenAPIOperation>>
}

const objectType = operation(function* (schema: AnyType) {
  const properties = (schema.properties ?? {}) as Record<string, AnyType>
  const required = new Set<string>(schema.required)
  const parts: string[] = []
  for (const [key, value] of Object.entries(properties)) {
    parts.push(`${key}${required.has(key) ? '' : '?'}: ${yield* jsonSchemaToTs(value)}`)
  }
  if (parts.length > 0) {
    return `{ ${parts.join('; ')} }`
  }
  if (schema.additionalProperties === true) {
    return 'Record<string, unknown>'
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    return `Record<string, ${yield* jsonSchemaToTs(schema.additionalProperties)}>`
  }
  return 'Record<string, never>'
})

/** Map the JSON Schema carried by OpenAPI request/response metadata to TypeScript source. */
const jsonSchemaToTs = operation(function* (schema: AnyType): ManualOperation<string> {
  if (!schema || typeof schema !== 'object') {
    return 'unknown'
  }
  if ('const' in schema) {
    return yield* JsonCodec.actions.stringify(schema.const)
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const parts: string[] = []
    for (const value of schema.enum) {
      parts.push(yield* JsonCodec.actions.stringify(value))
    }
    return parts.join(' | ')
  }
  const variants = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined
  if (variants) {
    const parts: string[] = []
    for (const variant of variants) {
      parts.push(yield* jsonSchemaToTs(variant))
    }
    return parts.join(' | ')
  }
  if (schema.type === 'string' && schema.format === 'binary') {
    return 'Blob'
  }
  if (schema.type === 'string') {
    return 'string'
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    return 'number'
  }
  if (schema.type === 'boolean') {
    return 'boolean'
  }
  if (schema.type === 'null') {
    return 'null'
  }
  if (schema.type === 'array') {
    return `(${yield* jsonSchemaToTs(schema.items)})[]`
  }
  if (schema.type === 'object') {
    return yield* objectType(schema)
  }
  return 'unknown'
})

const jsonMediaSchema = (content: Record<string, OpenAPIMedia> | undefined): AnyType =>
  content?.['application/json']?.schema

const requestMediaSchema = (content: Record<string, OpenAPIMedia> | undefined): AnyType =>
  content?.['multipart/form-data']?.schema ?? jsonMediaSchema(content)

const argsSchema = (entry: OpenAPIOperation): AnyType => {
  const body = requestMediaSchema(entry.requestBody?.content)
  if (body) {
    return body
  }

  const properties: Record<string, AnyType> = {}
  const required: string[] = []
  for (const parameter of entry.parameters ?? []) {
    properties[parameter.name] = parameter.schema ?? {}
    if (parameter.required) {
      required.push(parameter.name)
    }
  }
  return { type: 'object', properties, required }
}

const resultSchema = (entry: OpenAPIOperation): AnyType => {
  const responses = entry.responses ?? {}
  for (const status of ['200', '201', '202', '204', 'default']) {
    const schema = jsonMediaSchema(responses[status]?.content)
    if (schema) {
      return schema
    }
  }
  return undefined
}

/** The reactive payload schema: the explicit `x-ozaco-emits` when present, else the one-shot result
 * (a plain `.watch(...)` re-emits the same shape). */
const emitsSchema = (entry: OpenAPIOperation): AnyType =>
  entry['x-ozaco-emits'] ?? resultSchema(entry)

const operationKind = (method: string, entry: OpenAPIOperation): FnKind =>
  entry['x-ozaco-kind'] ?? (method === 'get' || method === 'head' ? 'query' : 'mutation')

/** Generate the typed client surface directly from the Docs plugin's OpenAPI document. */
export const generateApi = operation(function* (document: OpenAPIDocument) {
  const namespaces = new Map<string, string[]>()
  // Per-namespace realtime transport, read from `x-ozaco-realtime` — so the client picks WS/SSE from
  // the generated contract instead of probing at runtime.
  const realtimes = new Map<string, 'websocket' | 'sse'>()

  for (const path of Object.values(document.paths)) {
    for (const [method, entry] of Object.entries(path)) {
      if (!entry.operationId) {
        continue
      }
      const separator = entry.operationId.lastIndexOf('.')
      if (separator < 1 || separator === entry.operationId.length - 1) {
        continue
      }

      const namespace = entry.operationId.slice(0, separator)
      const name = entry.operationId.slice(separator + 1)
      const args = yield* jsonSchemaToTs(argsSchema(entry))
      const result = yield* jsonSchemaToTs(resultSchema(entry))
      const emits = yield* jsonSchemaToTs(emitsSchema(entry))
      const kind = operationKind(method, entry)
      const functions = namespaces.get(namespace) ?? []
      functions.push(
        `    ${name}: { kind: '${kind}'; args: ${args}; result: ${result}; emits: ${emits} }`,
      )
      namespaces.set(namespace, functions)
      if (entry['x-ozaco-realtime']) {
        realtimes.set(namespace, entry['x-ozaco-realtime'])
      }
    }
  }

  const source = [...namespaces.entries()].map(
    ([namespace, functions]) => `  ${namespace}: {\n${functions.join('\n')}\n  }`,
  )
  const type = `export type Api = {\n${source.join('\n')}\n}\n`

  // The runtime companion to `Api`: pass it to `createClient({ url, meta: apiMeta })` and the client
  // opens each namespace's realtime channel over the declared transport — no runtime detection.
  const metaEntries = [...realtimes.entries()].map(
    ([namespace, transport]) => `  ${namespace}: { realtime: '${transport}' }`,
  )
  const meta =
    metaEntries.length > 0
      ? `\nexport const apiMeta = {\n${metaEntries.join(',\n')}\n} as const\n`
      : ''

  return `// generated by @ozaco/client from OpenAPI — do not edit\n\n${type}${meta}`
})

/** Fetch the Docs OpenAPI document and generate the `Api` type source. */
export const pull = operation(function* (url: string, path = '/docs/openapi') {
  const endpoint = `${url.replace(/\/$/u, '')}${path.startsWith('/') ? path : `/${path}`}`
  const response = yield* until(fetch(endpoint))
  if (!response.ok) {
    return yield* fail('request-failed', `GET ${endpoint} -> ${response.status}`)
  }
  const document = (yield* until(response.json())) as OpenAPIDocument
  return yield* generateApi(document)
})
