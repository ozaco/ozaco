import { createDefinition } from 'std:plugin'

import type { InputTypes } from '../../type'

import { context } from '../base'

export const formatter = createDefinition(({ use }) => {
  const ctx = use(context)

  const formatter =
    (open: string, close: string, replace = open) =>
    (input: InputTypes): string => {
      const string = `${input}`

      if (!ctx.enabled) return string

      const index = string.indexOf(close, open.length)
      return ~index ? open + replaceClose(string, close, replace, index) + close : open + string + close
    }

  const replaceClose = (string: string, close: string, replace: string, index: number) => {
    let result = '',
      cursor = 0

    do {
      result += string.substring(cursor, index) + replace
      cursor = index + close.length
      index = string.indexOf(close, cursor)
    } while (~index)

    return result + string.substring(cursor)
  }

  return formatter
})
