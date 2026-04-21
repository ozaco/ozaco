export interface DocsOptions {
  title?: string
  version?: string
  description?: string

  swagger?: string
  openapi?: string
}

export type DocsContext = Required<DocsOptions>
