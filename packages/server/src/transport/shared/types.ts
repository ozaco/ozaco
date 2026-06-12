import type { Result } from 'std:result'

/** Close value a transport stream settles with: `true` on a clean end, or a mid-stream failure. */
export type StreamClose = true | Result.Failure<unknown>

/** A pump's terminal state: a clean `'end'`, a failure, or `undefined` when halted before settling. */
export type PumpOutcome = 'end' | Result.Failure<unknown> | undefined
