import type { Future } from 'std:effect'
import { attempt, call, operation, until } from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { DbDriver } from '../defaults'
import type {
  ClientConfiguration,
  DatabasePool,
  DatabasePoolConnection,
  DatabaseTransactionConnection,
  DriverConnection,
  Interceptor,
  PoolState,
  Query,
  QueryResultRow,
  QuerySqlToken,
  ResolvedClientConfiguration,
  StreamHandler,
} from '../types'

import { encodeCopyBinary } from './copy'
import { executeQuery, makeQueryMethods } from './engine'
import { classifyPostgresError, DbError } from './errors'

const raw = (sql: string): Query => ({ sql, values: [] })

/** Apply Slonik's defaults to a user config. */
const resolveConfiguration = (config: ClientConfiguration): ResolvedClientConfiguration => ({
  connectionUri: config.connectionUri,
  captureStackTrace: config.captureStackTrace ?? false,
  connectionTimeout: config.connectionTimeout ?? 5000,
  idleInTransactionSessionTimeout: config.idleInTransactionSessionTimeout ?? 60_000,
  idleTimeout: config.idleTimeout ?? 5000,
  maximumPoolSize: config.maximumPoolSize ?? 10,
  minimumPoolSize: config.minimumPoolSize ?? 0,
  maximumConnectionAge: config.maximumConnectionAge ?? 1_800_000,
  statementTimeout: config.statementTimeout ?? 0,
  connectionRetryLimit: config.connectionRetryLimit ?? 3,
  transactionRetryLimit: config.transactionRetryLimit ?? 5,
  queryRetryLimit: config.queryRetryLimit ?? 5,
  gracefulTerminationTimeout: config.gracefulTerminationTimeout ?? 5000,
  interceptors: config.interceptors ?? [],
  typeParsers: config.typeParsers ?? [],
  ssl: config.ssl,
  resetConnectionQuery:
    config.resetConnectionQuery === undefined ? 'DISCARD ALL' : config.resetConnectionQuery,
})

/** Run a control statement (BEGIN / COMMIT / SAVEPOINT …) directly, classifying any driver error. */
const exec = operation(function* (connection: DriverConnection, sql: string) {
  const outcome = yield* attempt(connection.query(raw(sql)))
  if (isFailure(outcome)) {
    return yield* classifyPostgresError(outcome.error)
  }
})

// --- run / streamRun bound to a physical connection -----------------------------------------------

interface RunDeps {
  readonly connection: DriverConnection
  readonly interceptors: readonly Interceptor[]
  readonly poolId: string
  readonly transactionId?: string | undefined
}

const makeRun = (deps: RunDeps) =>
  operation(function* (token: QuerySqlToken<AnyType>) {
    const queryId = yield* IO.actions.uuid()
    return yield* executeQuery(
      {
        connection: deps.connection,
        interceptors: deps.interceptors,
        context: {
          queryId,
          connectionId: deps.connection.connectionId,
          poolId: deps.poolId,
          transactionId: deps.transactionId,
          originalQuery: { sql: token.sql, values: token.values },
        },
      },
      token,
    )
  })

const makeStreamRun = (deps: RunDeps) =>
  operation(function* (token: QuerySqlToken<AnyType>, handler: StreamHandler<AnyType>) {
    const stream = yield* deps.connection.stream({ sql: token.sql, values: token.values })
    const subscription = yield* stream
    for (;;) {
      const step = yield* subscription.next()
      if (step.done) {
        break
      }
      let row: QueryResultRow = step.value
      if (token.parser) {
        const parsed = token.parser.safeParse(row)
        if (!parsed.success) {
          return yield* fail(DbError.DataIntegrity, 'streamed row failed validation')
        }
        row = parsed.data
      }
      yield* handler(row)
    }
  })

// --- transactions (BEGIN/COMMIT/ROLLBACK + savepoint nesting + retry) ------------------------------

interface TxDeps extends RunDeps {
  readonly retryLimit: number
}

/**
 * Run `handler` inside a transaction. `savepoint` (nested) uses SAVEPOINT/RELEASE/ROLLBACK TO;
 * otherwise BEGIN/COMMIT/ROLLBACK. Retries on `DbError.TransactionRollback`
 * (serialization/deadlock) up to `retryLimit`.
 */
const runTransaction = operation(function* (
  deps: TxDeps,
  handler: (connection: DatabaseTransactionConnection) => Future<AnyType>,
  depth: number,
) {
  const savepoint = depth > 0 ? `ozaco_sp_${depth}` : null

  for (let attemptIndex = 0; ; attemptIndex += 1) {
    yield* exec(deps.connection, savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN')

    const transactionId = yield* IO.actions.uuid()
    const run = makeRun({ ...deps, transactionId })
    const streamRun = makeStreamRun({ ...deps, transactionId })
    const methods = makeQueryMethods(run, streamRun)
    const connection = {
      ...methods,
      transactionId,
      transaction: (
        nested: (connection: DatabaseTransactionConnection) => Future<AnyType>,
        retryLimit?: number,
      ): Future<AnyType> =>
        runTransaction(
          { ...deps, transactionId, retryLimit: retryLimit ?? deps.retryLimit },
          nested,
          depth + 1,
        ),
    } as unknown as DatabaseTransactionConnection

    const outcome = yield* attempt(handler(connection))

    if (!isFailure(outcome)) {
      yield* exec(deps.connection, savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT')
      return outcome.value
    }

    yield* attempt(
      exec(deps.connection, savepoint ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK'),
    )

    const retryable = outcome.error === DbError.TransactionRollback
    if (retryable && attemptIndex < deps.retryLimit) {
      continue
    }
    return yield* outcome
  }
})

// --- bounded connection pool ----------------------------------------------------------------------

interface ConnectionPool {
  acquire(): Future<DriverConnection>
  release(connection: DriverConnection): Future<void>
  end(): Future<void>
  state(maximumPoolSize: number): PoolState
}

const createConnectionPool = (config: ResolvedClientConfiguration): ConnectionPool => {
  const idle: DriverConnection[] = []
  const waiters: Array<(connection: DriverConnection) => void> = []
  let acquiredCount = 0
  let ended = false

  const connectWithRetry = operation(function* () {
    for (let attemptIndex = 0; ; attemptIndex += 1) {
      const outcome = yield* attempt(DbDriver.actions.connect(config))
      if (!isFailure(outcome)) {
        return outcome.value
      }
      if (attemptIndex >= config.connectionRetryLimit) {
        return yield* classifyPostgresError(outcome.error)
      }
    }
  })

  const acquire = operation(function* () {
    if (ended) {
      return yield* fail(DbError.Connection, 'pool has ended')
    }
    const existing = idle.pop()
    if (existing) {
      return existing
    }
    if (acquiredCount < config.maximumPoolSize) {
      acquiredCount += 1
      const outcome = yield* attempt(connectWithRetry())
      if (isFailure(outcome)) {
        acquiredCount -= 1
        return yield* outcome
      }
      return outcome.value
    }
    return yield* until(
      new Promise<DriverConnection>(resolve => {
        waiters.push(resolve)
      }),
    )
  })

  const release = operation(function* (connection: DriverConnection) {
    if (config.resetConnectionQuery) {
      yield* attempt(connection.query(raw(config.resetConnectionQuery)))
    }
    const waiter = waiters.shift()
    if (waiter) {
      waiter(connection)
      return
    }
    idle.push(connection)
  })

  const end = operation(function* () {
    ended = true
    const draining = idle.splice(0)
    for (const connection of draining) {
      yield* attempt(connection.close())
    }
    yield* attempt(DbDriver.actions.end())
  })

  const state = (maximumPoolSize: number): PoolState => ({
    acquiredConnections: acquiredCount,
    idleConnections: idle.length,
    pendingConnections: waiters.length,
    maximumPoolSize,
  })

  return { acquire, release, end, state }
}

/** Acquire a connection, run `use`, and always release it (on success or failure). */
const withConnection = operation(function* (
  pool: ConnectionPool,
  use: (connection: DriverConnection) => Future<AnyType>,
) {
  const connection = yield* pool.acquire()
  const outcome = yield* attempt(use(connection))
  yield* pool.release(connection)
  if (isFailure(outcome)) {
    return yield* outcome
  }
  return outcome.value
})

// --- createPool -----------------------------------------------------------------------------------

/**
 * Establish a connection pool and return the {@link DatabasePool} handle — the effect-native /
 * Result port of Slonik's `createPool`. Query methods run on an implicitly acquired connection;
 * `connect`/`transaction` scope a connection to a routine.
 */
export const createPool = operation(function* (config: ClientConfiguration) {
  const resolved = resolveConfiguration(config)
  const pool = createConnectionPool(resolved)
  const poolId = yield* IO.actions.uuid()
  const interceptors = resolved.interceptors

  const poolMethods = makeQueryMethods(
    token =>
      withConnection(pool, connection => makeRun({ connection, interceptors, poolId })(token)),
    (token, handler) =>
      withConnection(pool, connection =>
        makeStreamRun({ connection, interceptors, poolId })(token, handler),
      ),
  )

  const connect = (use: (connection: DatabasePoolConnection) => Future<AnyType>): Future<AnyType> =>
    withConnection(pool, connection => {
      const deps: RunDeps = { connection, interceptors, poolId }
      const methods = makeQueryMethods(makeRun(deps), makeStreamRun(deps))
      const handle = {
        ...methods,
        connectionId: connection.connectionId,
        transaction: (
          routine: (connection: DatabaseTransactionConnection) => Future<AnyType>,
          retryLimit?: number,
        ): Future<AnyType> =>
          runTransaction(
            { ...deps, retryLimit: retryLimit ?? resolved.transactionRetryLimit },
            routine,
            0,
          ),
      } as unknown as DatabasePoolConnection
      return use(handle)
    })

  const transaction = (
    routine: (connection: DatabaseTransactionConnection) => Future<AnyType>,
    retryLimit?: number,
  ): Future<AnyType> =>
    withConnection(pool, connection =>
      runTransaction(
        {
          connection,
          interceptors,
          poolId,
          retryLimit: retryLimit ?? resolved.transactionRetryLimit,
        },
        routine,
        0,
      ),
    )

  const copyFromBinary = operation(function* (
    query: QuerySqlToken,
    tuples: ReadonlyArray<readonly unknown[]>,
    columnTypes: readonly string[],
  ) {
    // encode first (pure; throws → Result failure via `call`) so a bad tuple never checks out a conn
    const payload = yield* call<Uint8Array>(() => encodeCopyBinary(tuples, columnTypes))
    yield* withConnection(
      pool,
      operation(function* (connection: DriverConnection) {
        if (!connection.copyFromBinary) {
          return yield* fail(
            DbError.UnexpectedState,
            'the installed driver does not support binary COPY',
          )
        }
        yield* connection.copyFromBinary(query.sql, payload)
      }),
    )
  })

  const databasePool = {
    ...poolMethods,
    poolId,
    connect,
    transaction,
    copyFromBinary,
    state: () => pool.state(resolved.maximumPoolSize),
    end: () => pool.end(),
  }

  return databasePool as unknown as DatabasePool
})
