/** Marker symbols for the schema DSL's runtime objects. */
export const COLUMN = Symbol.for('db:column')
export const TABLE = Symbol.for('db:table')
export const SCHEMA = Symbol.for('db:schema')

/** System-field column names stamped on every stored document. */
export const ID = '_id'
export const CREATED = '_createdAt'
export const UPDATED = '_updatedAt'
export const VERSION = '_version'

/** The default keyset-pagination / watch sort column. */
export const DEFAULT_ORDER = CREATED

/** Names of the system columns (present on every table, never declared by the schema). */
export const SYSTEM_NAMES: readonly string[] = [ID, CREATED, UPDATED, VERSION]
