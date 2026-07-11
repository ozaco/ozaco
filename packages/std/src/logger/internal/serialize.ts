import type { Operation } from 'std:effect'

import { JsonCodec } from 'std:codec/impl/json'

import type { LoggerDef } from '../types/logger'

export const toRecord = (
  entry: LoggerDef.Entry,
  msgKey = 'msg',
  errorKey = 'err',
): Record<string, unknown> => {
  const record: Record<string, unknown> = {
    level: entry.level,
    time: entry.time,
    [msgKey]: entry.msg,
  }

  for (const key of Object.keys(entry.bindings)) {
    record[key] = entry.bindings[key]
  }

  if (entry.data) {
    for (const key of Object.keys(entry.data)) {
      record[key] = entry.data[key]
    }
  }

  if (entry.error) {
    record[errorKey] = entry.error
  }

  return record
}

export const toJson = (entry: LoggerDef.Entry, msgKey = 'msg', errorKey = 'err') =>
  JsonCodec.actions.stringify(toRecord(entry, msgKey, errorKey))

export const toNdjson = function* (
  entry: LoggerDef.Entry,
  msgKey = 'msg',
  errorKey = 'err',
): Operation<string> {
  return `${yield* toJson(entry, msgKey, errorKey)}\n`
}
