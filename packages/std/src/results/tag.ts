import { Tags } from './utils/tag'

export const resultTags = Tags.create('std/results')
  .add('unexpected')
  .add('invalid-usage')

  // causes
  .add('tags-get', 'tags#get')
