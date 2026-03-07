import { type BlobType, isAsyncGenerator, isGenerator, isPromise } from 'std:shared'

import type { Impl } from '../types'
import { appendCauses } from './append-causes'
import { auto } from './auto'
import { pipe } from './pipe'
import { fail } from './result'

export const guard: Impl.Guard = (...args: BlobType[]): BlobType => {
  const firstArgument = args[0]
  const causes = args.slice(1)

  return (...innerArgs: BlobType[]) => {
    const extract = (res: BlobType) => {
      if (isGenerator(res)) {
        return res.next().value
      } else if (isAsyncGenerator(res)) {
        return res.next().then((r: BlobType) => r.value)
      }

      return res
    }

    try {
      const res = firstArgument(...innerArgs)

      if (isPromise(res)) {
        return pipe(
          res.then(extract, (err: BlobType) =>
            fail(err instanceof Error ? err : new Error(String(err)), 'from guard', ...causes),
          ),
          appendCauses(...causes),
          auto(),
        )
      }

      return pipe(extract(res), appendCauses(...causes), auto())
    } catch (err) {
      return fail(err instanceof Error ? err : new Error(String(err)), 'from guard', ...causes)
    }
  }
}
