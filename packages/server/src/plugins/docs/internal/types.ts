import type { AnyType } from 'std:shared'

import type { ActionMeta } from 'server:service'

export interface JsonSchema {
  type?: string
  properties?: Record<string, AnyType>
  required?: string[]
  [key: string]: unknown
}

export interface ParameterObject {
  name: string
  in: 'query' | 'path'
  required?: boolean
  schema?: JsonSchema
}

export interface OperationObject {
  tags?: string[]
  summary?: string
  description?: string
  operationId?: string
  parameters?: ParameterObject[]
  requestBody?: { required?: boolean; content: Record<string, { schema: JsonSchema }> }
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema: JsonSchema }> }
  >
}

export interface OpenAPIDocument {
  openapi: string
  info: { title: string; version: string; description?: string }
  paths: Record<string, Record<string, OperationObject>>
}

export interface SwaggerOptions {
  openapi: string
  title: string
}

export interface CompiledEntry {
  service: string
  key: string
  method: string
  path: string
  meta: ActionMeta<AnyType>
}
