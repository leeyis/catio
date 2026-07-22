import { describe, expect, it } from 'vitest'
import { firstShellCommand, planAgentShellExecution, runAgentShellLoop } from './agentExecution'

describe('Agent shell execution policy', () => {
  const answer = '查看结果：\n```sh\nnvidia-smi\n```'

  it('defaults to no automatic execution in manual mode', () => {
    expect(planAgentShellExecution(answer, 'manual')).toEqual({ action: 'none' })
  })

  it('runs a read-only command in ask mode and asks for unknown or destructive commands', () => {
    expect(planAgentShellExecution(answer, 'ask')).toEqual({ action: 'run', command: 'nvidia-smi' })
    expect(planAgentShellExecution('```bash\nrm -rf /tmp/demo\n```', 'ask').action).toBe('confirm')
    expect(planAgentShellExecution('```powershell\nnpm install\n```', 'ask').action).toBe('confirm')
    expect(planAgentShellExecution('```sh\nsystemctl list-units\n```', 'ask').action).toBe('confirm')
    expect(planAgentShellExecution('```sh\nsystemctl list-units --no-pager\n```', 'ask')).toEqual({ action: 'run', command: 'systemctl list-units --no-pager' })
    expect(planAgentShellExecution('```sh\nollama list\n```', 'ask')).toEqual({ action: 'run', command: 'ollama list' })
  })

  it('asks before commands that can mutate state, execute nested commands, or expose secrets', () => {
    const commands = [
      'git branch -D main',
      'env sh -c "touch /tmp/pwn"',
      'nvidia-smi --gpu-reset',
      'cat ~/.ssh/id_rsa',
      'kubectl get secret -o yaml',
      'Get-Content C:\\Users\\me\\.ssh\\id_rsa',
    ]
    for (const command of commands) {
      expect(planAgentShellExecution(`\`\`\`sh\n${command}\n\`\`\``, 'ask')).toEqual({ action: 'confirm', command })
    }
  })

  it('full access runs the first complete shell fence only', () => {
    const markdown = '```sql\nselect 1\n```\n```bash\necho first\n```\n```sh\necho second\n```'
    expect(firstShellCommand(markdown)).toBe('echo first')
    expect(planAgentShellExecution(markdown, 'auto')).toEqual({ action: 'run', command: 'echo first' })
  })

  it('ignores unlabeled, inline and incomplete code', () => {
    expect(firstShellCommand('`whoami`\n```\nwhoami\n```\n```sh\nunclosed')).toBeNull()
  })

  it('does not automatically execute a multi-line shell block', () => {
    expect(firstShellCommand('```sh\necho one\necho two\n```')).toBeNull()
    expect(planAgentShellExecution('```sh\necho one\necho two\n```', 'auto').action).toBe('repair')
  })

  it('keeps executing one command per turn until the Agent returns a final answer', async () => {
    const commands: string[] = []
    const result = await runAgentShellLoop('```sh\nfirst\n```', 'auto', async plan => {
      if (plan.action === 'repair') return null
      commands.push(plan.command)
      return commands.length === 1 ? '```sh\nsecond\n```' : 'Task complete.'
    })

    expect(commands).toEqual(['first', 'second'])
    expect(result).toEqual({ limitReached: false })
  })

  it('asks the Agent to repair an invalid shell block instead of silently ending the loop', async () => {
    const actions: string[] = []
    const result = await runAgentShellLoop('```sh\necho one\necho two\n```', 'auto', async plan => {
      actions.push(plan.action)
      if (plan.action === 'repair') return '```sh\necho one && echo two\n```'
      return 'Task complete.'
    })

    expect(actions).toEqual(['repair', 'run'])
    expect(result).toEqual({ limitReached: false })
  })
})
