import { capsule, err } from '../../results'
import type { BlobType, EmptyType } from '../../shared'

import { ioTags } from '../tag'

export type ExtractEnvsCallback<T extends EmptyType> = (envList: BlobType) => T
export type Target = 'bun' | 'node'

/**
 * The extractEnvs function retrieves environment variables based on the specified target
 * (either Bun.env or process.env) and validates them using a callback function,
 * Throws an error if any variable is invalid.
 * Returns the processed environment variables for further use.
 */
export const extractEnvs = capsule(
  <T extends EmptyType>(callback: ExtractEnvsCallback<T>, target: Target = 'bun') => {
    const selectedTarget: BlobType =
      // biome-ignore lint/nursery/noProcessEnv: Redundant
      target === 'bun' && typeof Bun !== 'undefined' ? Bun.env : process.env

    const result = callback(selectedTarget)

    for (const [key, value] of Object.entries(result)) {
      if (value === null || value === undefined) {
        return err(ioTags.get('not-found'), `env.${key} is not found`).throw()
      }
    }

    return result
  },
  ioTags.get('extract-envs')
)
