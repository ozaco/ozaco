// oxlint-disable import/exports-last
import type { LiveChange, TableSpec } from 'db:core'
import type { Flow, Operation } from 'std:effect'
import {
  attempt,
  createQueue,
  ensure,
  fork,
  operation,
  sleep,
  until,
  withResolvers,
} from 'std:effect'
import { isFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { Client } from 'pg'

import { quoteIdent } from '../shared/compile'
import { decodeRows, postgresDialect } from '../shared/dialects'

import { raise } from './internal'

export const CHANNEL = 'ozaco_changes'

/** Reconnect budget for the dedicated listener connection. */
export interface PgLiveOptions {
  /** Redial attempts per outage before the feed closes for good. Default 10. */
  readonly retries?: number | undefined
  /** Base delay before the first redial. Default 250. */
  readonly delayMs?: number | undefined
  /** Exponential backoff factor between redials. Default 2. */
  readonly backoff?: number | undefined
  /** Backoff ceiling. Default 30_000. */
  readonly maxDelayMs?: number | undefined
}

interface Budget {
  readonly retries: number
  readonly delayMs: number
  readonly backoff: number
  readonly maxDelayMs: number
}

const budgetOf = (options: PgLiveOptions): Budget => ({
  retries: options.retries ?? 10,
  delayMs: options.delayMs ?? 250,
  backoff: options.backoff ?? 2,
  maxDelayMs: options.maxDelayMs ?? 30_000,
})

/** The shared trigger function: one JSON notification per committed row change. Payloads over the
 * NOTIFY limit drop the row body (`d: null`) — watchers re-fetch by id. */
const NOTIFY_FUNCTION = `
CREATE OR REPLACE FUNCTION ozaco_notify_change() RETURNS trigger AS $$
DECLARE
  rec RECORD;
  op TEXT;
  payload TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN rec := OLD; ELSE rec := NEW; END IF;
  op := CASE TG_OP WHEN 'INSERT' THEN 'insert' WHEN 'UPDATE' THEN 'update' ELSE 'delete' END;
  payload := json_build_object('t', TG_TABLE_NAME, 'o', op, 'i', rec."_id", 'x', txid_current(), 'd', row_to_json(rec))::text;
  IF octet_length(payload) > 7500 THEN
    payload := json_build_object('t', TG_TABLE_NAME, 'o', op, 'i', rec."_id", 'x', txid_current(), 'd', NULL)::text;
  END IF;
  PERFORM pg_notify('${CHANNEL}', payload);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql`

/** Idempotent per-table trigger (re)creation — safe to run on migrate, feed open and redial. */
export const triggerSql = (table: string): string =>
  `DROP TRIGGER IF EXISTS ozaco_changes ON ${quoteIdent(table)}; ` +
  `CREATE TRIGGER ozaco_changes AFTER INSERT OR UPDATE OR DELETE ON ${quoteIdent(table)} ` +
  'FOR EACH ROW EXECUTE FUNCTION ozaco_notify_change()'

interface WirePayload {
  readonly t: string
  readonly o: LiveChange['op']
  readonly i: unknown
  /** backend-global cursor (`txid_current()`), forwarded for cross-node resume protocols. */
  readonly x?: number | undefined
  readonly d: Record<string, unknown> | null
}

interface Session {
  readonly client: AnyType
  readonly dropped: Operation<void>
}

/**
 * Open the LISTEN/NOTIFY live feed: a dedicated listener connection plus AFTER-row triggers on
 * every declared table. NOTIFY is transactional, so events fan out only on commit and rolled-back
 * writes never surface — and because the trigger fires for ANY writer, external writes (psql,
 * `raw`, other processes) reach watchers too.
 *
 * A dropped listener redials with exponential backoff (see {@link PgLiveOptions}); notifications
 * missed during the outage cannot be replayed, so each successful redial synthesizes a table-level
 * `touch` per declared table — watchers re-read and heal. Only an exhausted budget closes the
 * feed. Triggers on tables that do not exist yet are skipped and installed by `migrate` when the
 * table is created.
 */
export const openLiveFeed = operation(function* (
  connection: { readonly url: string; readonly ssl?: AnyType },
  options: PgLiveOptions,
  tables: readonly TableSpec[],
) {
  const budget = budgetOf(options)
  const specs = new Map(tables.map(table => [table.name, table]))
  const queue = createQueue<LiveChange, void>()

  const dial = operation(function* (): Generator<AnyType, Session, AnyType> {
    const client = new Client({ connectionString: connection.url, ssl: connection.ssl })
    const opened = yield* attempt(until(client.connect() as Promise<AnyType>))
    if (isFailure(opened)) {
      yield* attempt(until(client.end() as Promise<void>))
      return yield* raise(opened.error)
    }
    const prepared = yield* attempt(
      until(client.query(`${NOTIFY_FUNCTION}; LISTEN ${CHANNEL}`) as Promise<AnyType>),
    )
    if (isFailure(prepared)) {
      yield* attempt(until(client.end() as Promise<void>))
      return yield* raise(prepared.error)
    }
    for (const table of tables) {
      // tolerate missing tables (migrations: 'manual'); migrate installs their triggers later
      yield* attempt(until(client.query(triggerSql(table.name)) as Promise<AnyType>))
    }

    const resolvers = withResolvers<void>('pg live listener dropped')
    let settled = false
    const drop = (): void => {
      if (!settled) {
        settled = true
        resolvers.resolve(undefined)
      }
    }
    client.on('notification', (message: AnyType) => {
      try {
        const payload = JSON.parse(String(message.payload)) as WirePayload
        const spec = specs.get(payload.t)
        if (!spec) {
          return
        }
        const doc = payload.d ? decodeRows(postgresDialect, spec, [payload.d])[0]! : null
        queue.add({
          table: payload.t,
          id: String(payload.i),
          op: payload.o,
          doc,
          cursor: payload.x,
        })
      } catch {
        // a malformed foreign payload on the channel is ignored, never fatal
      }
    })
    client.on('error', drop)
    client.on('end', drop)
    return { client, dropped: resolvers.operation }
  })

  // the first dial runs inline so a broken configuration fails the install loudly
  const holder = { session: yield* dial(), closed: false }
  yield* ensure(function* () {
    holder.closed = true
    yield* attempt(until(holder.session.client.end() as Promise<void>))
  })

  const supervise = operation(function* () {
    for (;;) {
      yield* holder.session.dropped
      if (holder.closed) {
        return
      }
      yield* attempt(until(holder.session.client.end() as Promise<void>))
      let recovered = false
      for (let attemptNo = 0; attemptNo < budget.retries; attemptNo += 1) {
        yield* sleep(Math.min(budget.delayMs * budget.backoff ** attemptNo, budget.maxDelayMs))
        if (holder.closed) {
          return
        }
        const redial = yield* attempt(dial())
        if (isSuccess(redial)) {
          holder.session = redial.value
          recovered = true
          break
        }
      }
      if (!recovered) {
        // budget exhausted — close the feed; DbClient has no live source anymore
        queue.close(undefined)
        return
      }
      // NOTIFY has no replay: events during the outage are lost, so synthesize a table-level
      // touch per table — every watcher re-reads and heals
      for (const table of tables) {
        queue.add({ table: table.name, id: '', op: 'touch', doc: null })
      }
    }
  })
  yield* fork(() => supervise())

  return {
    *[Symbol.iterator]() {
      return queue
    },
  } as Flow<LiveChange, void>
})
