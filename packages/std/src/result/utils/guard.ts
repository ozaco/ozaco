import { isAsyncGenerator, isGenerator, isPromise, pipe, type AnyType } from 'std:shared'

import { appendCauses } from './append-causes'
import type { Impl } from '../types/impl'
import { fail } from './fail'
import { auto } from './auto'

export const guard: Impl.Guard = (...args: AnyType[]): AnyType => {
  const firstArgument = args[0]
  const causes = args.slice(1)

  return (...innerArgs: AnyType[]) => {
    const extract = (res: AnyType) => {
      if (isGenerator(res)) {
        return res.next().value
      } else if (isAsyncGenerator(res)) {
        return res.next().then((r: AnyType) => r.value)
      }

      return res
    }

    try {
      const res = firstArgument(...innerArgs)

      if (isPromise(res)) {
        return pipe(
          res.then(extract, (err: AnyType) =>
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
