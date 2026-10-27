import type { Operation } from 'std:effect'
import { toBase64, toHex } from 'std:shared'

import type { IODef } from '../../types/io'
import { toPath } from '../../utils/to-path'

const encoder = new TextEncoder()

const encoded = (bytes: Uint8Array, encoding: IODef.HashEncoding | undefined) =>
  encoding === undefined ? bytes : encoding === 'hex' ? toHex(bytes) : toBase64(bytes)

/** Lift a raw digest into the `hash` action: bytes by default, text for `{ encoding }`; a string
 * is digested as its UTF-8 bytes. */
export const withEncoding = (
  digest: (algorithm: IODef.HashAlgorithm, data: Uint8Array) => Operation<Uint8Array>,
): IODef.Hash =>
  function* hash(
    algorithm: IODef.HashAlgorithm,
    data: Uint8Array | string,
    options?: { encoding: IODef.HashEncoding },
  ) {
    const bytes = yield* digest(algorithm, typeof data === 'string' ? encoder.encode(data) : data)

    return encoded(bytes, options?.encoding)
  } as IODef.Hash

/** Lift a streaming file digest into the `hashFile` action: bytes by default, text for
 * `{ encoding }`. */
export const withFileEncoding = (
  digest: (path: string, algorithm: IODef.HashAlgorithm) => Operation<Uint8Array>,
): IODef.HashFile =>
  function* hashFile(
    path: IODef.PathLike,
    algorithm: IODef.HashAlgorithm,
    options?: { encoding: IODef.HashEncoding },
  ) {
    const bytes = yield* digest(toPath(path), algorithm)

    return encoded(bytes, options?.encoding)
  } as IODef.HashFile
