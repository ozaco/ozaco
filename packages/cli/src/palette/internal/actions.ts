import { useContext } from 'std:effect'

import { Palette } from '../definition'

export function* colorsAction() {
  return (yield* useContext(Palette)).colors
}

export function* symbolsAction() {
  return (yield* useContext(Palette)).symbols
}
