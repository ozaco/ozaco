import type { BlobType, LiteralUnion } from '../../shared'

import { err } from './err'

/**
 * Tags Manager for result system. It's used to create a tag for a result.
 * Use `Tags.create` to create a new instance. Use `Tags.add` to add a new tag.
 * For better type inference, use with chaining `Tags.add(...).add(...)`.
 */
export class Tags<U extends [string, string], T extends string> {
  tags = new Map<string, string>()

  constructor(protected base: T) {}

  /**
   * Adds a new tag to the Tag Manager.
   */
  add<K extends string, V extends string = never>(key: K, value?: V) {
    const tag = `${this.base}.${value ?? key}`

    if (!this.tags.get(key)) {
      this.tags.set(key, tag)
    }

    return this as Tags<U | [K, V], T>
  }

  /**
   * Gets a specific key (can be a tag or a value) from the Tag Manager.
   * If the key is not found, an error is thrown.
   */
  get<K extends LiteralUnion<U['0'], `?${string}`>>(key: K) {
    const found = this.tags.get(key)

    if (!found) {
      return err('std/results.unexpected', `${key} cannot found in: ${this.base} tags`)
        .appendCause('std/results.tags#get')
        .throw()
    }

    type R = Extract<U, [K, BlobType]>['1']

    return found as R extends never ? `${T}.${K}` : `${T}.${R}`
  }

  /**
   * Checks if the Tag Manager has a specific key (can be a tag or a value).
   */
  has<const K extends string>(
    key: K
  ): K extends Std.ExtractErrors<Tags<U, T>> ? true : K extends U['0'] ? true : false {
    const found = this.tags.get(key) ?? this.tags.values().find(tag => tag.includes(key))

    return !!found as BlobType
  }

  static create<T extends string>(base: T) {
    return new Tags<never, T>(base)
  }
}
