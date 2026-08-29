/** `bun run scripts/codegen.ts [url] > src/api.gen.ts` — a standalone `Api` type from the manifest. */
import { pull } from 'client:codegen'
import { run } from 'std:effect'
import { unwrap } from 'std:result'

const url = process.argv[2] ?? 'http://127.0.0.1:3000'
console.log(unwrap(await run(() => pull(url))))
