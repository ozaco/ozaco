import type { Helpers } from '../types/helpers'

export const toRecord = (
  entry: Helpers.LogEntry,
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

export const toJson = (entry: Helpers.LogEntry, msgKey = 'msg', errorKey = 'err'): string =>
  JSON.stringify(toRecord(entry, msgKey, errorKey))

export const toNdjson = (entry: Helpers.LogEntry, msgKey = 'msg', errorKey = 'err'): string =>
  `${toJson(entry, msgKey, errorKey)}\n`
