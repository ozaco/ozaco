import { Tags } from '../results'

export const cryptoTags = Tags.create('std/crypto')
  .add('id', '$id')

  // ----- modules -----
  .add('modern')
  .add('legacy')
  .add('unsafe')
