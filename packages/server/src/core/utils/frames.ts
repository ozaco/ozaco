import { z } from 'zod'

/**
 * The typed realtime frame vocabulary — ONE schema shared by edge validation, the docs manifest
 * and client codegen (replaces the old unvalidated `FRAMES` stub and the prose wire contract).
 */
export const clientFrame = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('watch'),
    id: z.string(),
    fn: z.string(),
    args: z.unknown().optional(),
    /** Resume point after reconnect — the last `version` the client observed. */
    since: z.number().int().nonnegative().optional(),
  }),
  z.object({ event: z.literal('unwatch'), id: z.string() }),
])

export const serverFrame = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sync'),
    id: z.string(),
    version: z.number().int().nonnegative(),
    rows: z.array(z.unknown()),
  }),
  z.object({
    type: z.literal('delta'),
    id: z.string(),
    version: z.number().int().nonnegative(),
    added: z.array(z.unknown()),
    changed: z.array(z.unknown()),
    removed: z.array(z.string()),
  }),
  /** The client's `since` is stale — resubscribe without `since` and expect a fresh `sync`. */
  z.object({ type: z.literal('reset'), id: z.string() }),
  z.object({
    type: z.literal('error'),
    id: z.string(),
    error: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
])

export type ClientFrame = z.infer<typeof clientFrame>
export type ServerFrame = z.infer<typeof serverFrame>
