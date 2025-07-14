import { Tags } from '../results'

export const cryptoTags = Tags.create('std/crypto')
  .add('id', '$id')
  .add('uuid', '$uuid')

  // ----- modules -----
  .add('modern')
  .add('legacy')
  .add('unsafe')
