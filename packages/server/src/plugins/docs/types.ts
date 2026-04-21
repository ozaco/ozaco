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
