class Tier<T> {
  items: (T | undefined)[] = []
  head = 0
  constructor(public maxDeadSlots = 1024) {}

  push(item: T): void {
    this.items.push(item)
  }

  shift(): T | undefined {
    if (this.head < this.items.length) {
      const item = this.items[this.head]
      this.items[this.head] = undefined
      this.head++
      // maybe compact
      if (this.head > this.maxDeadSlots) {
        this.items = this.items.slice(this.head)
        this.head = 0
      }
      return item
    }
  }

  get length() {
    return this.items.length - this.head
  }
}

export class PriorityQueue<T> {
  public tiers: Tier<T>[] = []
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
