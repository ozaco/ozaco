import { createEvent } from 'std:event'
import { pipe } from 'std:result'
import { type BlobType, isFunction } from 'std:shared'

import { DEFINITION } from '../const'
import type { Helpers, Impl } from '../types'

export const createDefinition: Impl.CreateDefinition = (valueOrFn = {}) => {
  const event = createEvent() as Helpers.AnyDefinition['event']

  let key: string | undefined,
    value: unknown = valueOrFn,
    required: BlobType[] = []

  const result: Helpers.AnyDefinition = {
    _t: DEFINITION,

    event,

    getKey: () => key,

    getValue: options => {
      if (isFunction(value)) {
        return value(options)
      }

      return value
    },

    getRequired: () => required,

    key: value => {
      key = value as never

      return result as BlobType
    },

    require: (...args) => {
      required.push(...args)

      return result
    },

    optional: (...args) => {
      required = required.filter(args.includes)

      return result
    },

    extend: cb => {
      if (isFunction(value)) {
        const prev = value

        value = (options: BlobType) =>
          pipe(
            prev,
            prev => prev(options),
            curr => {
              options.def = curr

              return cb(options)
            },
          )
      } else {
        value = (options: BlobType) => {
          options.def = value

          return cb(options)
        }
      }

      const newResult = createDefinition(value)

      if (required.length > 0) {
        newResult.require(...(required as never[]))
      }

      return newResult as Helpers.AnyDefinition
    },
  }

  return result
}

export const isDefinition = (value: unknown): value is Helpers.AnyDefinition => {
  return typeof value === 'object' && value !== null && '_t' in value && value._t === DEFINITION
}
