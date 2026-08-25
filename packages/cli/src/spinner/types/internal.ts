export type NodeStatus = 'pending' | 'success' | 'fail' | 'warn' | 'info'

export interface TreeNode {
  type: 'spinner' | 'bar'
  message: string
  status: NodeStatus
  value: number
  total: number
  width: number
  children: TreeNode[]
}
