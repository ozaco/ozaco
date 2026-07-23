import type { Action, GatewayDef } from 'server:core'
import type { AnyType } from 'std:shared'

export namespace DocsDef {
  export interface AuthOptions {
    type?: 'bearer' | 'basic' | 'apiKey'
    name?: string
    in?: 'header' | 'query' | 'cookie'
    bearerFormat?: string
    description?: string
  }

  export interface Options {
    title?: string
    version?: string
    description?: string

    swagger?: string
    openapi?: string
    silent?: boolean

    auth?: boolean | AuthOptions
  }

  export interface Context {
    title: string
    version: string
    description: string

    swagger: string
    openapi: string
    silent?: boolean

    auth: AuthOptions | null
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
    'x-ozaco-kind'?: 'query' | 'mutation' | 'action' | 'stream'
    'x-ozaco-emits'?: JsonSchema
    'x-ozaco-realtime'?: 'websocket' | 'sse'
    'x-ozaco-upload-mode'?: 'buffer' | 'stream'
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
    rest: GatewayDef.RestOptions
    meta: Action.Meta<AnyType>
  }

  export interface SwaggerHtmlOptions {
    openapi: string
    title: string
    auth: boolean
  }
}
