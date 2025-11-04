import type { BlobType } from 'std:shared'

import { auto, isErr, unexpected } from './result'

export const handleAsync = async <T extends PromiseLike<BlobType>>(value: T) => {
  Object.assign(value, {
    async *[Symbol.asyncIterator](): BlobType {
      const result = await value

      if (isErr(result)) {
        yield result
      }

      return result._v
    },
  })
}

export const handle = (value: BlobType, causes: string[]) => {
  if (isErr(value)) {
    return handleError(value, causes)
  }

  return auto(value)
}

export const handleError = (error: BlobType, causes: string[]) => {
  if (isErr(error)) {
    if (causes.length > 0) {
      error._c.unshift(...causes)
    }

    return error
  }

  return unexpected(error as Error, causes)
}
