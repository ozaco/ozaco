import type { EdgeDef } from 'server:core'
import type { Operation } from 'std:effect'

import { CONSOLE_HTML } from './console.gen'

/**
 * The dev console at `/_observe`: the embedded `apps/observe` single-file app (no CDN, no build
 * step at runtime). Its data rides the REAL `observe` service (`/_observe/api/*`), mounted with
 * every other action — this route only serves the page.
 */
export function* mountConsole(edge: EdgeDef.Handle): Operation<void> {
  yield* edge.actions.raw({
    method: 'GET',
    path: '/_observe',
    *handler() {
      return new Response(CONSOLE_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    },
  })
}
