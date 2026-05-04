import type { SchemaDef } from '../../utils/schema/types'

export interface PostgresConfig {
  readonly url: string
  readonly schema: SchemaDef
  readonly max?: number
}
