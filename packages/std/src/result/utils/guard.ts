import { isAsyncGenerator, isGenerator, isPromise, pipe } from 'std:shared'
import type { AnyType } from 'std:shared'

import type { Impl } from '../types/impl'

import { appendCauses } from './append-causes'
import { auto } from './auto'
import { fail } from './fail'

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
          res.then(extract, (error: AnyType) =>
            fail(
              error instanceof Error ? error : new Error(String(error)),
              'from guard',
              ...causes,
            ),
          ),
          appendCauses(...causes),
          auto(),
        )
      }

      return pipe(extract(res), appendCauses(...causes), auto())
    } catch (error) {
      return fail(
        error instanceof Error ? error : new Error(String(error)),
        'from guard',
        ...causes,
      )
    }
  }
}
