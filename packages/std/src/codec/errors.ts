import { createTags } from 'std:shared'

/**
 * The codec failure tags. Raised today: `Encode` / `Decode` / `Stringify` / `Parse` (also by the
 * flow actions — a failing `encodeFlow` / `decodeFlow` closes or fails with `Encode` / `Decode`),
 * `AlreadyRegistered` (`register` — a DIFFERENT impl claiming a registered name) and `Cancelled`
 * (`JsonCodec.decodeFlow` halted mid-stream).
 *
 * RESERVED, never raised by std: `EncodeFlow`, `DecodeFlow`, `NoCodec`, `NoMatch`. A protocol call
 * with no codec installed does not fail `NoCodec` — the plugin runtime answers first with
 * `PluginErrors.MissingAction`.
 */
export const CodecErrors = createTags(
  'std:codec',

  'encode',
  'decode',
  'stringify',
  'parse',
  'encode-flow',
  'decode-flow',
  'no-codec',

  'no-match',
  'already-registered',
  'cancelled',
)
