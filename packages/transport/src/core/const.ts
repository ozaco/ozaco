/** Protocol subtype marker. */
export const TRANSPORT = Symbol.for('transport:transport')

/** Wire header names core stamps on every message (a backend without native headers frames
 * them into the payload itself — see the redis driver). */
export enum HEADERS {
  /** what the payload is: a codec value, raw bytes, or a lane frame kind. */
  kind = 'oz-kind',
  /** lane frame sequence number (0-based). */
  seq = 'oz-seq',
  /** reply topic of a request (emulated request/reply). */
  reply = 'oz-reply',
  /** `ok` | `fail` on a reply. */
  result = 'oz-result',
  /** `<id>/<index>/<count>` on one part of a payload split over the backend's size limit. */
  chunk = 'oz-chunk',
  /** `<bytes>`: this request/reply carries no payload — it rides the parcel sideband. */
  parcel = 'oz-parcel',
  /** correlation id of a request (the cancel subject is derived from it). */
  cid = 'oz-cid',
  /** `<ms>` the caller of a request is willing to wait — how long its peer holds a sideband
   * open for it, and no longer. */
  wait = 'oz-wait',
}

/** `oz-kind` values. */
export enum KINDS {
  value = 'value',
  bytes = 'bytes',
  data = 'data',
  chunk = 'chunk',
  end = 'end',
  fail = 'fail',
  credit = 'credit',
  cancel = 'cancel',
}

/** Topic prefix the consumer side of a lane sends credit on (`$credit.<topic>`). */
export const CREDIT_PREFIX = '$credit.'

/** Topic prefix of emulated request/reply inboxes. */
export const INBOX_PREFIX = '$inbox.'
/** Topic prefix a caller publishes on when it abandons a request (`$cancel.<cid>`). */
export const CANCEL_PREFIX = '$cancel.'
/** Topic prefix of the request/reply sideband an oversize payload travels on
 * (`$parcel.<cid>.<in|out>`). */
export const PARCEL_PREFIX = '$parcel.'

export const DEFAULT_TIMEOUT_MS = 5000
/** Bytes a chunk leaves for headers under the backend's payload limit. */
export const CHUNK_HEADER_ALLOWANCE = 1024
/** How long a subscriber keeps a partial chunk assembly before forgetting it. */
export const CHUNK_TIMEOUT_MS = 30_000
/** How long a parcel transfer may stall — no consumer attached, no credit, no frame — before
 * the side that waits gives up. Bounds the pause between frames, not the transfer itself: a
 * payload of any size may take as long as it takes. */
export const PARCEL_IDLE_MS = 30_000
/** The floor under a caller's own `timeoutMs` when its peer decides how long to hold an
 * oversize REPLY open: a caller that stopped waiting orphans that answer, and the bytes are
 * held until the sideband gives up — so it gives up on the caller's own patience, never on the
 * full idle window, but always leaves a beat for the caller to attach. */
export const PARCEL_MIN_WAIT_MS = 1000
export const DEFAULT_CREDIT = 32
/** Bytes one byte-lane frame carries at most. A `writable` slices every write down to this, so
 * a stream of ANY size travels in bounded frames (and stays under a backend's payload limit,
 * which further clamps it) — memory in flight is `credit * frameBytes`, not the payload. */
export const DEFAULT_FRAME_BYTES = 256 * 1024
/** How often a lane consumer re-announces credit until the first frame arrives. */
export const CREDIT_ANNOUNCE_MS = 100
