import type { Operation } from 'std:effect'
import { toBase64, toHex } from 'std:shared'

import type { IODef } from '../../types/io'

/** Lift a raw digest into the `hash` action: bytes by default, text for `{ encoding }`. */
export const withEncoding = (
  digest: (algorithm: IODef.HashAlgorithm, data: Uint8Array) => Operation<Uint8Array>,
): IODef.Hash =>
  function* hash(
    algorithm: IODef.HashAlgorithm,
    data: Uint8Array,
    options?: { encoding: IODef.HashEncoding },
  ) {
    const bytes = yield* digest(algorithm, data)

    if (options?.encoding === undefined) {
      return bytes
    }
    return options.encoding === 'hex' ? toHex(bytes) : toBase64(bytes)
  } as IODef.Hash
