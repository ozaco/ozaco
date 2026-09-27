/** One priority level of a `PriorityQueue`: a FIFO that compacts its dead head slots. */
export class Tier<T> {
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
