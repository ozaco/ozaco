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
  /** correlation id of a request (the cancel subject is derived from it). */
  cid = 'oz-cid',
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

export const DEFAULT_TIMEOUT_MS = 5000
/** Bytes a chunk leaves for headers under the backend's payload limit. */
export const CHUNK_HEADER_ALLOWANCE = 1024
/** How long a subscriber keeps a partial chunk assembly before forgetting it. */
export const CHUNK_TIMEOUT_MS = 30_000
export const DEFAULT_CREDIT = 32
/** How often a lane consumer re-announces credit until the first frame arrives. */
export const CREDIT_ANNOUNCE_MS = 100
