/** `bun run scripts/client.ts [url]` — the typed client walk-through against a running demo,
 * printing every step (`walk()` is what the e2e test asserts on too). */
import { run } from 'std:effect'
import { unwrap } from 'std:result'

import { walk } from '../src'

const url = process.argv[2] ?? 'http://127.0.0.1:3000'

unwrap(
  await run(function* () {
    yield* walk(url, step => {
      console.log(`• ${step.name}:`, JSON.stringify(step.detail))
    })
  }),
)
