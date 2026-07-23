import type { Future, Operation, Stream } from 'std:effect'

import type { ZodType } from 'zod'

import type {
  ARRAY_TOKEN,
  BINARY_TOKEN,
  DATE_TOKEN,
  FRAGMENT_TOKEN,
  IDENTIFIER_TOKEN,
  INTERVAL_TOKEN,
  JSON_BINARY_TOKEN,
  JSON_TOKEN,
  LIST_TOKEN,
  QUERY_TOKEN,
  TIMESTAMP_TOKEN,
  UNNEST_TOKEN,
  UNSAFE_TOKEN,
} from '../const'

/**
 * Shared contracts for the client — the effect-native / Result port of Slonik's `@slonik/types`.
 * Everything async is a `std:effect` {@link Future}; nothing throws (errors surface as Result
 * failures tagged from {@link DbError}).
 */

// --- primitive values + compiled query ------------------------------------------------------------

/** A value that can be bound as a query parameter (or nested in an array binding). */
export type PrimitiveValueExpression =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | readonly PrimitiveValueExpression[]

/** A JSON-serializable value (for `sql.json` / `sql.jsonb`). */
export type SerializableValue =
  | string
  | number
  | boolean
  | null
  | readonly SerializableValue[]
  | { readonly [key: string]: SerializableValue }

/** A compiled, parameterized statement handed to a {@link DriverConnection}. */
export interface Query {
  readonly sql: string
  readonly values: readonly PrimitiveValueExpression[]
}

/** One column descriptor from the backend. */
export interface Field {
  readonly name: string
  readonly dataTypeId: number
}

/** A backend notice (e.g. `RAISE NOTICE`). */
export interface Notice {
  readonly code?: string
  readonly message: string
  readonly severity?: string
}

export type QueryResultRow = Record<string, PrimitiveValueExpression>

/** The result of a query, after row transformation + type parsing (Slonik's `QueryResult`). */
export interface QueryResult<Row> {
  readonly command: 'COPY' | 'DELETE' | 'INSERT' | 'SELECT' | 'UPDATE'
  readonly fields: readonly Field[]
  readonly notices: readonly Notice[]
  readonly rowCount: number
  readonly rows: readonly Row[]
}

/** A raw, parameterized SQL fragment produced by `sql.fragment`/`sql.unsafe` or nested in a query. */
export interface FragmentSqlToken {
  readonly type: typeof FRAGMENT_TOKEN
  readonly sql: string
  readonly values: readonly PrimitiveValueExpression[]
}

/** A top-level query produced by the `sql`/`sql.type(...)` tag; `parser` validates each result row. */
export interface QuerySqlToken<Row extends QueryResultRow = QueryResultRow> {
  readonly type: typeof QUERY_TOKEN
  readonly sql: string
  readonly values: readonly PrimitiveValueExpression[]
  readonly parser: ZodType<Row> | null
}

export interface IdentifierSqlToken {
  readonly type: typeof IDENTIFIER_TOKEN
  readonly names: readonly string[]
}

export interface ListSqlToken {
  readonly type: typeof LIST_TOKEN
  readonly members: readonly ValueExpression[]
  readonly glue: FragmentSqlToken
}

export interface ArraySqlToken {
  readonly type: typeof ARRAY_TOKEN
  readonly values: readonly PrimitiveValueExpression[]
  readonly memberType: string | FragmentSqlToken
}

export interface UnnestSqlToken {
  readonly type: typeof UNNEST_TOKEN
  readonly tuples: ReadonlyArray<readonly PrimitiveValueExpression[]>
  readonly columnTypes: ReadonlyArray<string | FragmentSqlToken>
}

export interface JsonSqlToken {
  readonly type: typeof JSON_TOKEN | typeof JSON_BINARY_TOKEN
  readonly value: SerializableValue
}

export interface BinarySqlToken {
  readonly type: typeof BINARY_TOKEN
  readonly data: Uint8Array
}

export interface DateSqlToken {
  readonly type: typeof DATE_TOKEN
  readonly date: Date
}

export interface TimestampSqlToken {
  readonly type: typeof TIMESTAMP_TOKEN
  readonly date: Date
}

export interface IntervalInput {
  readonly years?: number
  readonly months?: number
  readonly days?: number
  readonly hours?: number
  readonly minutes?: number
  readonly seconds?: number
}

export interface IntervalSqlToken {
  readonly type: typeof INTERVAL_TOKEN
  readonly interval: IntervalInput
}

export interface UnsafeSqlToken {
  readonly type: typeof UNSAFE_TOKEN
  readonly sql: string
}

/** Any non-query token that can be interpolated into a `sql`/`sql.fragment` template. */
export type SqlToken =
  | FragmentSqlToken
  | QuerySqlToken
  | IdentifierSqlToken
  | ListSqlToken
  | ArraySqlToken
  | UnnestSqlToken
  | JsonSqlToken
  | BinarySqlToken
  | DateSqlToken
  | TimestampSqlToken
  | IntervalSqlToken
  | UnsafeSqlToken

/** What may appear in a `${...}` interpolation: a bound primitive, or any token. */
export type ValueExpression = PrimitiveValueExpression | SqlToken

// --- driver contract ------------------------------------------------------------------------------

/** Raw result straight from a concrete driver (before row transform / type parsing). */
export interface DriverQueryResult {
  readonly command: QueryResult<QueryResultRow>['command']
  readonly fields: readonly Field[]
  readonly notices: readonly Notice[]
  readonly rowCount: number
  readonly rows: readonly QueryResultRow[]
}

/** A single physical connection owned by a {@link Driver}. All methods are effect-native. */
export interface DriverConnection {
  readonly connectionId: string
  query(query: Query): Future<DriverQueryResult>
  stream(query: Query): Future<Stream<QueryResultRow, void>>
  /** Return the connection to a usable baseline after use (Slonik's `resetConnection`, e.g.
   * `DISCARD ALL`). */
  reset(): Future<void>
  close(): Future<void>
  /** Optional: write a pre-encoded binary COPY payload for `COPY … FROM STDIN WITH (FORMAT binary)`
   * (Postgres only). Drivers without COPY support omit this, and the pool fails the call. */
  copyFromBinary?(statement: string, payload: Uint8Array): Future<void>
}

// The concrete backend is a `DbDriver` plugin (see `core/utils/driver.ts`): `setup()` returns
// `{ dialect }` and its `connect`/`end` actions hand out connections. `createPool` calls those
// actions directly, so `ClientConfiguration` no longer carries a driver factory.

// --- type parsers ---------------------------------------------------------------------------------

/** Maps a Postgres type name (or OID mapping the driver resolves) to a native value. */
export interface TypeParser<T = unknown> {
  readonly name: string
  parse(value: string): T
}

// --- interceptors ---------------------------------------------------------------------------------

/** Ambient context passed to every interceptor hook. */
export interface QueryContext {
  readonly queryId: string
  readonly connectionId: string
  readonly poolId: string
  readonly transactionId?: string | undefined
  readonly originalQuery: Query
}

/**
 * A middleware over the query/connection/transaction lifecycle — the effect-native port of Slonik's
 * `Interceptor`. Every hook returns an {@link Operation}; hooks that can short-circuit a result return
 * a value (or `null` to continue). Ordering mirrors Slonik.
 */
export interface Interceptor {
  beforePoolConnection?(context: { readonly poolId: string }): Operation<void>
  afterPoolConnection?(context: QueryContext, connection: DriverConnection): Operation<void>
  beforePoolConnectionRelease?(context: QueryContext, connection: DriverConnection): Operation<void>
  /** Return a {@link QueryResult} to short-circuit execution (e.g. a cache hit), or `null` to run. */
  beforeQueryExecution?(
    context: QueryContext,
    query: Query,
  ): Operation<QueryResult<QueryResultRow> | null>
  beforeQueryResult?(
    context: QueryContext,
    query: Query,
    result: QueryResult<QueryResultRow>,
  ): Operation<void>
  afterQueryExecution?(
    context: QueryContext,
    query: Query,
    result: QueryResult<QueryResultRow>,
  ): Operation<void>
  beforeTransformQuery?(context: QueryContext, query: Query): Operation<void>
  transformQuery?(context: QueryContext, query: Query): Operation<Query>
  transformRow?(
    context: QueryContext,
    query: Query,
    row: QueryResultRow,
    fields: readonly Field[],
  ): Operation<QueryResultRow>
  queryExecutionError?(context: QueryContext, query: Query, error: unknown): Operation<void>
  beforeTransaction?(context: { readonly transactionId: string }): Operation<void>
  afterTransaction?(
    context: { readonly transactionId: string },
    outcome: 'commit' | 'rollback',
  ): Operation<void>
}

// --- client configuration -------------------------------------------------------------------------

/** SSL/TLS options passed through to the driver. */
export interface SslConfiguration {
  readonly ca?: string
  readonly cert?: string
  readonly key?: string
  readonly rejectUnauthorized?: boolean
}

/** Slonik's `ClientConfiguration`, ported. The installed `DbDriver` plugin selects the backend. */
export interface ClientConfiguration {
  /** `postgres://…` / `postgresql://…`, or a SurrealDB url for the surreal driver. */
  readonly connectionUri?: string
  readonly captureStackTrace?: boolean
  readonly connectionTimeout?: number
  readonly idleInTransactionSessionTimeout?: number
  readonly idleTimeout?: number
  readonly maximumPoolSize?: number
  readonly minimumPoolSize?: number
  readonly maximumConnectionAge?: number
  readonly statementTimeout?: number
  readonly connectionRetryLimit?: number
  readonly transactionRetryLimit?: number
  readonly queryRetryLimit?: number
  readonly gracefulTerminationTimeout?: number
  readonly interceptors?: readonly Interceptor[]
  readonly typeParsers?: readonly TypeParser[]
  readonly ssl?: SslConfiguration
  /** Post-release cleanup statement (Slonik default `DISCARD ALL`). Set `null` to disable. */
  readonly resetConnectionQuery?: string | null
}

/** The subset of {@link ClientConfiguration} with defaults applied. The three genuinely-optional
 * fields keep `| undefined` value types (required keys) so a resolver can set them explicitly. */
export type ResolvedClientConfiguration = Required<
  Omit<ClientConfiguration, 'connectionUri' | 'ssl' | 'resetConnectionQuery'>
> & {
  readonly connectionUri: string | undefined
  readonly ssl: SslConfiguration | undefined
  readonly resetConnectionQuery: string | null
}

// --- query methods (shared by pool / connection / transaction) ------------------------------------

export type StreamHandler<Row> = (row: Row) => Operation<void>

/** The query surface shared by the pool, a checked-out connection, and a transaction — the port of
 * Slonik's `CommonQueryMethods`. Every method fails (never throws) with a {@link DbError} tag. */
export interface CommonQueryMethods {
  query<Row extends QueryResultRow>(query: QuerySqlToken<Row>): Future<QueryResult<Row>>
  any<Row extends QueryResultRow>(query: QuerySqlToken<Row>): Future<readonly Row[]>
  anyFirst<Row extends QueryResultRow>(query: QuerySqlToken<Row>): Future<readonly unknown[]>
  many<Row extends QueryResultRow>(query: QuerySqlToken<Row>): Future<readonly Row[]>
  manyFirst<Row extends QueryResultRow>(query: QuerySqlToken<Row>): Future<readonly unknown[]>
  maybeOne<Row extends QueryResultRow>(query: QuerySqlToken<Row>): Future<Row | null>
  maybeOneFirst<Row extends QueryResultRow>(query: QuerySqlToken<Row>): Future<unknown>
  one<Row extends QueryResultRow>(query: QuerySqlToken<Row>): Future<Row>
  oneFirst<Row extends QueryResultRow>(query: QuerySqlToken<Row>): Future<unknown>
  exists(query: QuerySqlToken): Future<boolean>
  stream<Row extends QueryResultRow>(
    query: QuerySqlToken<Row>,
    handler: StreamHandler<Row>,
  ): Future<void>
}

/** A connection inside a transaction; can open nested (savepoint) transactions. */
export interface DatabaseTransactionConnection extends CommonQueryMethods {
  readonly transactionId: string
  transaction<T>(
    handler: (connection: DatabaseTransactionConnection) => Future<T>,
    retryLimit?: number,
  ): Future<T>
}

/** A connection checked out of the pool for the duration of a routine. */
export interface DatabasePoolConnection extends CommonQueryMethods {
  readonly connectionId: string
  transaction<T>(
    handler: (connection: DatabaseTransactionConnection) => Future<T>,
    retryLimit?: number,
  ): Future<T>
}

export interface PoolState {
  readonly acquiredConnections: number
  readonly idleConnections: number
  readonly pendingConnections: number
  readonly maximumPoolSize: number
}

/** The pool — the top-level handle `createPool` returns. Query methods run on an implicitly acquired
 * connection; `connect`/`transaction` scope a connection to a routine. */
export interface DatabasePool extends CommonQueryMethods {
  readonly poolId: string
  connect<T>(handler: (connection: DatabasePoolConnection) => Future<T>): Future<T>
  transaction<T>(
    handler: (connection: DatabaseTransactionConnection) => Future<T>,
    retryLimit?: number,
  ): Future<T>
  /** Bulk-load rows via Postgres binary COPY — the port of Slonik's `copyFromBinary`. `query` is the
   * `COPY … FROM STDIN WITH (FORMAT binary)` statement; each tuple is encoded per `columnTypes`. Fails
   * (never throws) with `DbError.UnexpectedState` if the driver lacks COPY support. */
  copyFromBinary(
    query: QuerySqlToken,
    tuples: ReadonlyArray<readonly unknown[]>,
    columnTypes: readonly string[],
  ): Future<void>
  state(): PoolState
  end(): Future<void>
}
