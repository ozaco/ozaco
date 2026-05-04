import type { SchemaDef } from '../../utils/schema/types'

export interface SqliteConfig {
  readonly url: string
  readonly schema: SchemaDef
}
