import { describe, expect, it, vi } from 'vitest'
import type { McpConnMeta, McpHostMeta } from './mcp'
import { createMcpTargetSyncQueue } from './mcp'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('MCP target synchronization', () => {
  it('keeps a newly connected SSH host when an older full snapshot is still in flight', async () => {
    const firstCall = deferred()
    const applied: Array<{ databases: McpConnMeta[]; hosts: McpHostMeta[] }> = []
    const sync = vi.fn(async (databases: McpConnMeta[], hosts: McpHostMeta[]) => {
      if (applied.length === 0) await firstCall.promise
      applied.push({ databases, hosts })
    })
    const enqueue = createMcpTargetSyncQueue(sync)
    const shanghai = { sessionId: 'sess-1', name: '上海公司AI服务器', host: 'root@10.0.0.1:22' }
    const development = { sessionId: 'sess-2', name: '开发环境(177)', host: 'dev@10.0.0.177:22' }

    const oldSnapshot = enqueue([], [shanghai])
    await Promise.resolve()
    const newSnapshot = enqueue([], [shanghai, development])
    await Promise.resolve()

    expect(sync).toHaveBeenCalledTimes(1)
    firstCall.resolve()
    await Promise.all([oldSnapshot, newSnapshot])

    expect(applied).toEqual([
      { databases: [], hosts: [shanghai] },
      { databases: [], hosts: [shanghai, development] },
    ])
  })

  it('continues with the latest snapshot after an earlier IPC failure', async () => {
    const applied: string[][] = []
    const sync = vi.fn()
      .mockRejectedValueOnce(new Error('webview closing'))
      .mockImplementationOnce(async (_databases: McpConnMeta[], hosts: McpHostMeta[]) => {
        applied.push(hosts.map(host => host.name))
      })
    const enqueue = createMcpTargetSyncQueue(sync)

    await expect(enqueue([], [])).rejects.toThrow('webview closing')
    await expect(enqueue([], [
      { sessionId: 'sess-2', name: '开发环境(177)', host: 'dev@10.0.0.177:22' },
    ])).resolves.toBeUndefined()

    expect(applied).toEqual([['开发环境(177)']])
  })
})
