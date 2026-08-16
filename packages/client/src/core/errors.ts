import { createTags } from 'std:shared'

/**
 * Client failure tags. Server-side failures pass through with their ORIGINAL tag (the `error`
 * field of the wire body / error frame) — these tags cover the conditions the client raises
 * itself: a request that could not be shaped or dispatched (`request`), a malformed realtime
 * frame (`frame`), a watch that could not be established (`watch`) and an unusable manifest
 * document (`manifest`).
 */
export const ClientErrors = createTags('client', 'request', 'frame', 'watch', 'manifest')
