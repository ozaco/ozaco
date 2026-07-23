// System-field column names stamped on every stored document, and the default keyset-pagination sort
// column. Kept internal (imported by relative path from impl/); the public `_id`/`_createdAt`/
// `_version` shape surfaces through `SystemFields` in `schema/types`.
export const ID = '_id'
export const CREATED = '_createdAt'
export const VERSION = '_version'
export const DEFAULT_ORDER = CREATED
