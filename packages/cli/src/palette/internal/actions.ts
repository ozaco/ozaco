import { operation, useContext } from 'std:effect'

import { Palette } from '../definition'

export const colorsAction = operation(function* () {
  return (yield* useContext(Palette)).colors
})

export const symbolsAction = operation(function* () {
  return (yield* useContext(Palette)).symbols
})
