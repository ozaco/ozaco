import { match } from '@ozaco/std/match'
import { isResult, type Result } from '@ozaco/std/result'

import z from 'zod/v3'

// ── Result + match via .when() ──

const input = 'sa' as 'sa' | 10 | Result<string, never>

const output = match(input)
  .with(z.literal('sa'), i => `${i}`)
  .with(z.literal(10), i => i * 10)
  .when(isResult, () => 2)
  .exhaustive()

console.log(output)
