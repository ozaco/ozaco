import type { Operation } from 'std:effect'
import { each } from 'std:effect'

import { createHash } from 'node:crypto'

import type { IODef } from '../../types/io'
import { readFileFlow } from '../fs/flow'

/** The `node:crypto` name of a {@link IODef.HashAlgorithm}. */
export const toNodeHash = (algorithm: IODef.HashAlgorithm) =>
  algorithm === 'SHA-256' ? 'sha256' : algorithm === 'SHA-384' ? 'sha384' : 'sha512'

/** Digest a file chunk by chunk through `node:crypto` (native on Bun and Node alike), so a
 * multi-GB archive costs one chunk of memory. The read flow's failure close (a missing file:
 * `std:io.not-found`) is raised by `each`. */
export function* digestFile(path: string, algorithm: IODef.HashAlgorithm): Operation<Uint8Array> {
  const hash = createHash(toNodeHash(algorithm))

  for (const chunk of yield* each(readFileFlow(path))) {
    hash.update(chunk)

    yield* each.next()
  }

  return new Uint8Array(hash.digest())
}
