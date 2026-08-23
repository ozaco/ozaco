import type { ObserveDef } from 'server:core'

/** The stdout mirror (dev): one line per request, failure and log — requestId first so a
 * request's lines can be grepped together. */
export const mirror = (event: ObserveDef.Event): void => {
  switch (event.t) {
    case 'request': {
      const { row } = event
      const what = row.method ? `${row.method} ${row.path}` : `${row.service}.${row.action}`
      const status = row.error ? `FAIL ${row.error}` : `ok ${row.status ?? ''}`

      console.log(
        `[oz] ${row.requestId.slice(0, 8)} ${what} ${status} ${row.durationMs ?? '?'}ms lane=${row.lane}`,
      )

      return
    }

    case 'failure': {
      const { row } = event

      console.log(
        `[oz] ${(row.requestId ?? '--------').slice(0, 8)}   ✗ ${row.tag} at ${row.where}: ${row.message}`,
      )

      return
    }

    case 'log': {
      const { row } = event

      console.log(
        `[oz] ${(row.requestId ?? '--------').slice(0, 8)}   ${row.level} ${row.msg}${row.data ? ` ${JSON.stringify(row.data)}` : ''}`,
      )

      return
    }

    default: {
      return
    }
  }
}
