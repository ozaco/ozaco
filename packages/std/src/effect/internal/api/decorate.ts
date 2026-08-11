import type { Helpers } from '../../types/helpers'
import type { Around, Middleware } from '../../types/operation'

function combine<TArgs extends unknown[], TReturn>(
  middlewares: Middleware<TArgs, TReturn>[],
): Middleware<TArgs, TReturn> {
  if (middlewares.length === 0) {
    return (args, next) => next(...args)
  }
  return middlewares.reduceRight(
    (sum, middleware) => (args, next) => middleware(args, (...inner) => sum(inner, next)),
  )
}

/**
 * Merge two decorators: on the `max` side earlier installs stay OUTERMOST, on the `min` side newer
 * installs land closer to the outside of the min chain — the full call order is always
 * max chain → min chain → core.
 */
export function decorate<A>(
  base: Helpers.Decorator<A>,
  next: Helpers.Decorator<A>,
): Helpers.Decorator<A> {
  return {
    max: base.max ? (next.max ? append(base.max, next.max) : base.max) : next.max,
    min: next.min ? (base.min ? append(next.min, base.min) : next.min) : base.min,
  }
}

/** Compose two partial around-maps member by member; `outer` runs before `inner`. */
export function append<A>(
  outer: Partial<Around<A>>,
  inner: Partial<Around<A>>,
): Partial<Around<A>> {
  const result: Partial<Around<A>> = { ...outer }
  for (const key of Object.keys(inner) as (keyof A)[]) {
    const current = outer[key]
    const decoration = inner[key]
    if (current) {
      const pair = [current, decoration] as Middleware<unknown[], unknown>[]
      result[key] = combine(pair) as Around<A>[keyof A]
    } else {
      result[key] = decoration
    }
  }
  return result
}
