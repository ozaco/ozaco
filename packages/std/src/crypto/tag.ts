import { Tags } from '../results'

export const cryptoTags = Tags.create('std/crypto')
  // ----- errors -----
  .add('ulid-parse-time')

  // ----- causes -----
  .add('id', '$id')
  .add('uuid', '$uuid')

  .add('ulid-time')
  .add('ulid-random')
  .add('ulid', '$ulid')
  .add('ulid-parse', '$ulidParse')

  // ----- modules -----
  .add('modern')
  .add('legacy')
  .add('unsafe')
  .add('shared')
