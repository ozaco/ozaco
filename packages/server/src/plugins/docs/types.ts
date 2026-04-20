import type { AnyType } from 'std:shared'

import type { ActionMeta } from 'server:service'

export interface DocsOptions {
  title?: string
  version?: string
  description?: string

  swagger?: string
  openapi?: string
}

export type DocsContext = Required<DocsOptions>

export interface CompiledEntry {
  service: string
  key: string
  method: string
  path: string
  meta: ActionMeta<AnyType>
}
