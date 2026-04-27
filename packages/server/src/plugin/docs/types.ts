import type { Helpers } from 'server:core'
import type { AnyType } from 'std:shared'

export interface DocsAuthOptions {
  type?: 'bearer' | 'basic' | 'apiKey'
  name?: string
  in?: 'header' | 'query' | 'cookie'
  bearerFormat?: string
  description?: string
}

export interface DocsOptions {
  title?: string
  version?: string
  description?: string

  swagger?: string
  openapi?: string

  auth?: boolean | DocsAuthOptions
}

export interface DocsContext {
  title: string
  version: string
  description: string

  swagger: string
  openapi: string

  auth: DocsAuthOptions | null
}

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
  security?: Array<Record<string, string[]>>
}

export interface SecurityScheme {
  type: 'http' | 'apiKey'
  scheme?: string
  bearerFormat?: string
  name?: string
  in?: 'header' | 'query' | 'cookie'
  description?: string
}

export interface OpenAPIDocument {
  openapi: string
  info: { title: string; version: string; description?: string }
  paths: Record<string, Record<string, OperationObject>>
  components?: { securitySchemes?: Record<string, SecurityScheme> }
}

export interface CompiledEntry {
  service: string
  key: string
  method: string
  path: string
  meta: Helpers.ActionMeta<AnyType>
}

export interface SwaggerHtmlOptions {
  openapi: string
  title: string
  auth: boolean
}
