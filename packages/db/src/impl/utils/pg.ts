// oxlint-disable import/exports-last
import type { DriverQueryResult, Field, QueryResultRow } from 'db:core'
import { attempt, call, operation } from 'std:effect'
import { isSuccess } from 'std:result'

import type { AnyType } from '@ozaco/std/shared'

import { dynamicImport } from './common'

const COMMANDS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'COPY'])

/** Map a node-`pg` result to the driver-agnostic {@link DriverQueryResult} (pg carries real column +
 * command metadata, so we use it directly rather than deriving from row keys). */
export const mapPgResult = (result: AnyType): DriverQueryResult => {
  const command = String(result?.command ?? 'SELECT').toUpperCase()
  return {
    command: (COMMANDS.has(command) ? command : 'SELECT') as DriverQueryResult['command'],
    fields: ((result?.fields ?? []) as AnyType[]).map(
      (field): Field => ({ name: String(field.name), dataTypeId: Number(field.dataTypeID ?? 0) }),
    ),
    notices: [],
    rowCount: Number(result?.rowCount ?? (Array.isArray(result?.rows) ? result.rows.length : 0)),
    rows: (result?.rows ?? []) as readonly QueryResultRow[],
  }
}

// Optional enhancers, resolved once (undefined = not yet loaded, null = absent).
let queryStreamCtor: AnyType
/** The `pg-query-stream` constructor when installed (real server-side cursor), else `null`. */
export const loadQueryStream = operation(function* () {
  if (queryStreamCtor === undefined) {
    const mod = yield* attempt(call<AnyType>(() => dynamicImport('pg-query-stream')))
    queryStreamCtor = isSuccess(mod) ? ((mod.value as AnyType).default ?? mod.value) : null
  }
  return queryStreamCtor
})

let copyFromFn: AnyType
/** The `pg-copy-streams` `from` factory when installed (enables `copyFromBinary`), else `null`. */
export const loadCopyFrom = operation(function* () {
  if (copyFromFn === undefined) {
    const mod = yield* attempt(call<AnyType>(() => dynamicImport('pg-copy-streams')))
    copyFromFn = isSuccess(mod)
      ? ((mod.value as AnyType).from ?? (mod.value as AnyType).default?.from ?? null)
      : null
  }
  return copyFromFn
})
