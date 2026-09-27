import type { EdgeDef } from 'server:core'
import { OBSERVE_CONSOLE_PATH } from 'server:internal'
import type { Operation } from 'std:effect'

import { CONSOLE_HTML } from './console.gen'

/**
 * The dev console at `/_observe`: the embedded `apps/observe` single-file app (no CDN, no build
 * step at runtime). Its data rides the REAL `observe` service (`/_observe/api/*`), mounted with
 * every other action and gated like one (`ObservePlugin.use({ auth })`) — this route only serves
 * the page, a static shell holding no data: public, so a browser can open it and hand the API a
 * bearer token when it asks for one. A plugin-owned route: recorded only when it fails, unless
 * `selfTrace`.
 */
export function* mountConsole(edge: EdgeDef, selfTrace: boolean): Operation<void> {
  yield* edge.actions.raw({
    method: 'GET',
    path: OBSERVE_CONSOLE_PATH,

    // the page is a static shell: its data rides the `observe` service, gated like every action
    // (`ObservePlugin.use({ auth })`) — a browser must be able to load it to send a token at all
    auth: false,
    observe: selfTrace ? 'on' : 'errors',
    *handler() {
      return new Response(CONSOLE_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    },
  })
}
