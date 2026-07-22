import { describe, expect, it } from 'vitest'
import { firstShellCommand, planAgentShellExecution, runAgentShellLoop } from './agentExecution'

describe('Agent shell execution policy', () => {
  const answer = '查看结果：\n```sh\nnvidia-smi\n```'

  it('defaults to no automatic execution in manual mode', () => {
    expect(planAgentShellExecution(answer, 'manual')).toEqual({ action: 'none' })
  })

  it('runs ordinary commands directly in ask mode', () => {
    expect(planAgentShellExecution(answer, 'ask')).toEqual({ action: 'run', command: 'nvidia-smi' })
    const commands = [
      'npm install',
      'mkdir -p build && touch build/ready',
      'echo ready > build/status.txt',
      'systemctl list-units',
      'kubectl get pods | head',
      'env sh -c "touch /tmp/ready"',
      'git add . && git commit -m "checkpoint"',
    ]
    for (const command of commands) {
      expect(planAgentShellExecution(`\`\`\`sh\n${command}\n\`\`\``, 'ask')).toEqual({ action: 'run', command })
    }
  })

  it('asks only before high-risk commands in semi-auto mode', () => {
    const commands = [
      'rm -rf /tmp/demo',
      'mv ./build /opt/app',
      'kill 1234',
      'restart nginx',
      'poweroff',
      'git branch -D main',
      'nvidia-smi --gpu-reset',
      'cat ~/.ssh/id_rsa',
      'kubectl get secret -o yaml',
      'Get-Content C:\\Users\\me\\.ssh\\id_rsa',
      'docker compose down',
      'terraform destroy',
      'DROP TABLE users',
    ]
    for (const command of commands) {
      expect(planAgentShellExecution(`\`\`\`sh\n${command}\n\`\`\``, 'ask')).toEqual({ action: 'confirm', command })
    }
  })

  it('full access runs the first complete shell fence only', () => {
    const markdown = '```sql\nselect 1\n```\n```bash\necho first\n```\n```sh\necho second\n```'
    expect(firstShellCommand(markdown)).toBe('echo first')
    expect(planAgentShellExecution(markdown, 'auto')).toEqual({ action: 'run', command: 'echo first' })
    expect(planAgentShellExecution('```sh\nrm -rf /\n```', 'auto')).toEqual({ action: 'run', command: 'rm -rf /' })
  })

  it('ignores unlabeled, inline and incomplete code', () => {
    expect(firstShellCommand('`whoami`\n```\nwhoami\n```\n```sh\nunclosed')).toBeNull()
  })

  it('does not automatically execute a multi-line shell block', () => {
    expect(firstShellCommand('```sh\necho one\necho two\n```')).toBeNull()
    expect(planAgentShellExecution('```sh\necho one\necho two\n```', 'auto').action).toBe('repair')
  })

  it('accepts a multi-line shell block when the single-line limit is disabled', () => {
    const markdown = '```sh\necho one\necho two\n```'
    expect(firstShellCommand(markdown, false)).toBe('echo one\necho two')
    expect(planAgentShellExecution(markdown, 'auto', false)).toEqual({ action: 'run', command: 'echo one\necho two' })
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

  it('uses the configured maximum number of execution rounds', async () => {
    let steps = 0
    const result = await runAgentShellLoop('```sh\necho next\n```', 'auto', async () => {
      steps += 1
      return '```sh\necho next\n```'
    }, { maxSteps: 3 })

    expect(steps).toBe(3)
    expect(result).toEqual({ limitReached: true })
  })
})
