import { createTags } from 'std:shared'

// every thrown value matches: the fold's tag is the operation's
const always = (): boolean => true

/** The `_t` JsonCodec writes on a Failure (whose own discriminant is a symbol JSON drops), so
 * decoding rebuilds it. */
export const FAILURE_TAG = 'std:result:failure'

/** How many failures deep JsonCodec encodes a cause chain (a cycle is cut where it closes). */
export const FAILURE_DEPTH = 64

/** How deep decoded JSON is searched for tagged failures. */
export const REVIVE_DEPTH = 256

/** The values a value is searched through before encoding assumes it holds a failure. */
export const SCAN_BUDGET = 10_000

/**
 * A codec's own serializer / parser throw, folded into the tag of the operation that failed — ONE
 * level: the throw's own message, the thrown value its `raw` (never a nested `std:result.unknown`).
 * The tags are `CodecErrors`' own (`std:codec.encode`, …).
 */
export const ENCODE_FOLD = createTags('std:codec', ['encode', always])
export const DECODE_FOLD = createTags('std:codec', ['decode', always])
export const STRINGIFY_FOLD = createTags('std:codec', ['stringify', always])
export const PARSE_FOLD = createTags('std:codec', ['parse', always])
