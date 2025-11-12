import { type BlobType, isAsyncGenerator, isGenerator } from 'std:shared'

import type { Impl } from '../types'
import { appendCauses } from './append-causes'
import { auto } from './auto'
import { pipe } from './pipe'

export const guard: Impl.Guard = (...args: BlobType[]): BlobType => {
  const firstArgument = args[0]
  const causes = args.slice(1)

  return (...args: BlobType[]) =>
    pipe(
      firstArgument(...args),
      result => {
        if (isGenerator(result)) {
          return result.next().value
        } else if (isAsyncGenerator(result)) {
          return result.next().then((result: BlobType) => result.value)
        }

        return result
      },
      appendCauses(...causes),
      auto(),
    )
}
