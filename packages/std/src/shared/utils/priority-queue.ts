class Tier<T> {
  constructor(
    public priority: number,
    public items: T[],
  ) {}
}

const parentOf = (index: number): number => Math.floor((index - 1) / 2)

const leftOf = (index: number) => index * 2 + 1

const rightOf = (index: number) => index * 2 + 2

export class PriorityQueue<T> {
  public tiers: Tier<T>[] = []
  public heap: Tier<T>[] = []

  push(priority: number, item: T) {
    const targetTier = this.tiers[priority]
    if (targetTier) {
      targetTier.items.unshift(item)
    } else {
      const tier = new Tier(priority, [item])
      this.tiers[priority] = tier
      let current = this.heap.length
      this.heap.push(tier)
      while (current > 0) {
        const p = parentOf(current)
        if (priority < this.heap[p]!.priority) {
          this.heap[current] = this.heap[p]!
          this.heap[p] = tier
        }
        current = p
      }
    }
  }

  pop(): T | undefined {
    const top = this.heap[0]
    if (!top) {
      return
    }
    const value = top.items.pop()!
    if (top.items.length === 0) {
      Reflect.deleteProperty(this.tiers, top.priority)

      const tier = this.heap.pop()!
      if (this.heap.length > 0) {
        let current = 0
        this.heap[0] = tier
        while (current < this.heap.length - 1) {
          const left_i = leftOf(current)
          const right_i = rightOf(current)
          const left = this.heap[left_i]
          const right = this.heap[right_i]

          if (left) {
            if (right) {
              if (tier.priority > left.priority || tier.priority > right.priority) {
                if (left.priority < right.priority) {
                  this.heap[current] = left
                  this.heap[left_i] = tier
                  current = left_i
                } else {
                  this.heap[current] = right
                  this.heap[right_i] = tier
                  current = right_i
                }
              } else {
                break
              }
            } else if (left.priority < tier.priority) {
              this.heap[current] = left
              this.heap[left_i] = tier
              current = left_i
            } else {
              break
            }
          } else {
            break
          }
        }
      }
    }
    return value
  }
}
