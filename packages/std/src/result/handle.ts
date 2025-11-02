import type { BlobType } from '@shared'

import { isErr, isOk, ok, unexpected } from './result'

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

  if (isOk(value)) {
    return value
  }

  return ok(value)
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
