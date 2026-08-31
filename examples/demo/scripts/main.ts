/** `bun run scripts/main.ts` — ONE monolith node on :3000. `main` wires SIGINT/SIGTERM into a
 * graceful shutdown; `ensure` stops the app on the way out. */
import { ensure, main, suspend } from 'std:effect'

import { createDemo } from '../src'

await main(function* () {
  const app = yield* createDemo({ port: 3000 })
  yield* ensure(function* () {
    console.log('[demo] stopping…')
    yield* app.stop()
    console.log('[demo] bye')
  })
  const info = yield* app.start()
  console.log(
    `[demo] ${info.role} · hosted: ${info.hosted.join(', ') || '(none)'} · ${info.url ?? 'no edge'} · ready: ${info.ready}`,
  )
  if (info.url) {
    console.log(
      `[demo] docs ${info.url}/docs · observe ${info.url}/_observe · health ${info.url}/_health`,
    )
  }
  yield* suspend()
})
