import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { Logger } from 'std:logger'
import { ActiveSpan, Suppressed } from 'std:trace'

import { DB_SYSTEMS, LOGGER_NAME, MAX_QUERY_TEXTS, MEMORY_SYSTEM } from '../internal/const'
import { QueryText } from '../internal/context'
import { driverCodeOf, statusCauseOf } from '../internal/driver'
import type { Adapter } from '../types/adapter'
import type { Helpers } from '../types/helpers'

/**
 * Note the text of one statement a SQL adapter is about to run, for the db span in progress
 * (`db.query.text`). Only PARAMETERIZED text belongs here — values travel as bind parameters. A
 * no-op outside a recording db span.
 */
export function* noteQuery(text: string): Operation<void> {
  const texts = yield* QueryText.get()

  if (texts && texts.length < MAX_QUERY_TEXTS) {
    texts.push(text)
  }
}

/**
 * The string cause a SQL adapter appends to the failure of a driver call: the code the driver
 * error carries — `sqlstate 23505` (pg / bun-sql), `sqlite SQLITE_CONSTRAINT_UNIQUE` (sqlite) —
 * which the db span reports as `db.response.status_code`. Read off the driver's rejection itself,
 * at the boundary: `asFailure(error, DbErrors, driverCause(error))`. `undefined` (no cause) for an
 * error that carries no such code.
 */
export const driverCause = (error: unknown): string | undefined => {
  const code = driverCodeOf(error)

  return code ? statusCauseOf(code) : undefined
}

/**
 * Run `body` with NO active span: what a background loop does (a watch's re-query, the change-feed
 * and bus pumps, a queue worker's claims) opens no child-only db span, and a long-lived span the
 * loop happened to be started under never grows with it.
 */
export const untraced = <T>(body: () => Operation<T>): Operation<T> =>
  ActiveSpan.with(null, () => body())

/** The `db.system.name` an adapter name stands for (`pg` / `bun-sql` ⇒ `postgresql`). */
export const dbSystemOf = (adapter: string): string => DB_SYSTEMS[adapter] ?? adapter

/**
 * A backend's telemetry identity: the adapter's own `telemetry` over the defaults its name
 * implies. An in-process store (`ozaco.memory`) is INTERNAL — there is no remote peer to draw.
 */
export const adapterIdentity = (info: Adapter.Options): Helpers.DbIdentity => {
  const system = info.telemetry?.system ?? dbSystemOf(info.adapter)
  const memory = system === MEMORY_SYSTEM

  return {
    system,
    namespace: info.telemetry?.namespace ?? (memory ? 'memory' : info.adapter),
    kind: memory ? 'internal' : 'client',
    address: info.telemetry?.address,
    port: info.telemetry?.port,
  }
}

/**
 * An operational log line (a bus gap, a lapsed lease) through the installed `Logger`, bound to
 * `logger: '@ozaco/db'` — never a failure of the caller. Nothing without a Logger, and nothing in
 * work whose telemetry is SUPPRESSED (an exporter's own store): its line could reach the console
 * but never the telemetry sinks, and every sink holds the same lines. `once`, when given, is
 * asked last — right before the write, with nothing in between — and `false` skips the line.
 */
// oxlint-disable-next-line max-params
export function* dbLog(
  level: 'info' | 'warn',
  message: string,
  data?: Readonly<Record<string, unknown>>,
  once?: () => boolean,
): Operation<void> {
  yield* attempt(function* () {
    if ((yield* Suppressed.get()) === true || !(yield* Logger.context.get())) {
      return
    }

    if (once && !once()) {
      return
    }

    yield* Logger.actions.child({ logger: LOGGER_NAME }, () =>
      data ? Logger.actions[level](message, { ...data }) : Logger.actions[level](message),
    )
  })
}
