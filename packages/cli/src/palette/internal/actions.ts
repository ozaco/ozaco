import { Palette } from 'cli:core'
import { operation, useContext } from 'std:effect'

export const colorsAction = operation(function* () {
  return (yield* useContext(Palette)).colors
})

export const symbolsAction = operation(function* () {
  return (yield* useContext(Palette)).symbols
})
