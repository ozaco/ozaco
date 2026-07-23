// --- plugin protocol subtypes ---------------------------------------------------------------------

export const DB_POOL = Symbol.for('db:pool:protocol')
export const DB_DRIVER = Symbol.for('db:driver:protocol')
export const DB_INTERCEPTOR = Symbol.for('db:interceptor:protocol')

// --- sql tokens (the `sql` tag AST) ---------------------------------------------------------------

export const FRAGMENT_TOKEN = 'SLONIK_TOKEN_FRAGMENT'
export const QUERY_TOKEN = 'SLONIK_TOKEN_QUERY'
export const IDENTIFIER_TOKEN = 'SLONIK_TOKEN_IDENTIFIER'
export const LIST_TOKEN = 'SLONIK_TOKEN_LIST'
export const ARRAY_TOKEN = 'SLONIK_TOKEN_ARRAY'
export const UNNEST_TOKEN = 'SLONIK_TOKEN_UNNEST'
export const JSON_TOKEN = 'SLONIK_TOKEN_JSON'
export const JSON_BINARY_TOKEN = 'SLONIK_TOKEN_JSON_BINARY'
export const BINARY_TOKEN = 'SLONIK_TOKEN_BINARY'
export const DATE_TOKEN = 'SLONIK_TOKEN_DATE'
export const TIMESTAMP_TOKEN = 'SLONIK_TOKEN_TIMESTAMP'
export const INTERVAL_TOKEN = 'SLONIK_TOKEN_INTERVAL'
export const UNSAFE_TOKEN = 'SLONIK_TOKEN_UNSAFE'
