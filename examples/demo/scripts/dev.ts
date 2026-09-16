/** `bun run scripts/dev.ts` — the monolith on :3000 with hot reload: save anything under `src/`
 * and the services swap in place while the port, the sockets and the database stay up. */
import { ensure, main, suspend } from 'std:effect'

import { createDemo } from '../src'

await main(function* () {
  const app = yield* createDemo({ port: 3000, hot: true })
  yield* ensure(function* () {
    console.log('[demo] stopping…')
    yield* app.stop()
    console.log('[demo] bye')
  })
  const info = yield* app.start()
  console.log(`[demo] ${info.role} · ${info.url ?? 'no edge'} · hot reload on src/`)
  yield* suspend()
})
