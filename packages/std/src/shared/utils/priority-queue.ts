import { Tier } from '../internal/tier'

export class PriorityQueue<T> {
  private readonly tiers: Tier<T>[] = []
  public min = 0
  public max = 0
  push(priority: number, item: T): void {
    let tier = this.tiers[priority]
    if (!tier) {
      const newTier = new Tier<T>()

      tier = newTier
      this.tiers[priority] = newTier
    }
    tier.push(item)
    if (priority < this.min) {
      this.min = priority
    }
    if (priority > this.max) {
      this.max = priority
    }
  }
  pop(): T | undefined {
    for (let current = this.min; current <= this.max; current++) {
      const items = this.tiers[current]
      if (items && items.length > 0) {
        const value = items.shift()!
        this.min = items.length === 0 ? current + 1 : current
        return value
      }
    }
    this.min = 0
    this.max = 0
  }
}
