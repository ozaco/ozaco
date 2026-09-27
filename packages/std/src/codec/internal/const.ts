/** The `_t` JsonCodec writes on a Failure (whose own discriminant is a symbol JSON drops), so
 * decoding rebuilds it. */
export const FAILURE_TAG = 'std:result:failure'

/** How many failures deep JsonCodec encodes a cause chain (a cycle is cut where it closes). */
export const FAILURE_DEPTH = 64

/** How deep decoded JSON is searched for tagged failures. */
export const REVIVE_DEPTH = 256

/** The values a value is searched through before encoding assumes it holds a failure. */
export const SCAN_BUDGET = 10_000
