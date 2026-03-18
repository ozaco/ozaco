import { isResult, type Result } from '@ozaco/std/result'
import { match } from '@ozaco/std/shared'

import z from 'zod/v3'

// ── Result + match via .when() ──

const input = 'alice' as 'alice' | 10 | Result<string, never>

const output = match(input)
  .with(z.literal('alice'), i => `Hi ${i}`)
  .with(z.literal(10), i => i * 10)
  .when(isResult, () => 2)
  .exhaustive()

console.log(output)
