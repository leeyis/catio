import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import type { ConnectionProfile } from '../../state/connections'

// ---- mock the db service so the test-connection path is driven without Tauri ----
const h = vi.hoisted(() => ({
  testConnection: vi.fn(),
  dbConnect: vi.fn(),
  saveProfile: vi.fn(),
  saveDbConnection: vi.fn(),
  sshTest: vi.fn(),
}))
vi.mock('../../services/db', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../services/db')>()
  return { ...mod, testConnection: h.testConnection, dbConnect: h.dbConnect }
})
vi.mock('../../state/connections', () => ({ saveProfile: h.saveProfile }))
vi.mock('../../state/dbConnections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/dbConnections')>()
  return { ...actual, saveDbConnection: h.saveDbConnection, generateProfileId: () => 'db-generated-id' }
})
vi.mock('../../services/ssh', async (orig) => {
  const actual = await orig<typeof import('../../services/ssh')>()
  return { ...actual, sshTest: h.sshTest }
})

import { NewConnectionModal } from './NewConnectionModal'

const PROFILE: ConnectionProfile = {
  id: 'live-1.2.3.4:22-deploy',
  name: 'my-server',
  host: '1.2.3.4',
  port: 2222,
  user: 'deploy',
  auth: { method: 'password' },
}

const PROFILE_WITH_JUMP: ConnectionProfile = {
  id: 'live-1.2.3.4:22-deploy',
  name: 'my-server',
  host: '1.2.3.4',
  port: 2222,
  user: 'deploy',
  auth: { method: 'password' },
  jump: {
    host: 'bastion.example.com',
    port: 22,
    user: 'ec2-user',
    auth: { method: 'password' },
  },
}

function wrap(ui: React.ReactNode) {
  return render(
    <LanguageProvider>
      <DataProvider>{ui}</DataProvider>
    </LanguageProvider>
  )
}

describe('NewConnectionModal', () => {
  beforeEach(() => {
    h.testConnection.mockReset()
    h.dbConnect.mockReset()
  })

  it('defaults to the DB kind and does not prefill mock values', () => {
    const { container } = wrap(<NewConnectionModal onClose={() => {}} />)
    // The DB engine picker (PostgreSQL) is shown → DB kind is active.
    expect(screen.getByText('PostgreSQL')).toBeTruthy()
    // No leftover mock prefill from the reference design.
    expect(container.textContent ?? '').not.toContain('prod-orders')
    const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[]
    expect(inputs.some(i => i.value === 'prod-orders')).toBe(false)
    expect(inputs.some(i => i.value === '10.0.4.2')).toBe(false)
    expect(inputs.some(i => i.value === 'app_ro')).toBe(false)
  })

  it('opens on the host tab when initialKind="host"', () => {
    wrap(<NewConnectionModal onClose={() => {}} initialKind="host" />)
    // Host kind shows the protocol segmented control (SSH) instead of the DB engine picker.
    expect(screen.getByText('SSH')).toBeTruthy()
    expect(screen.queryByText('PostgreSQL')).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('explains disabled credential storage and opens Security settings', () => {
    const onOpenSecuritySettings = vi.fn()
    wrap(
      <NewConnectionModal
        onClose={() => {}}
        initialKind="host"
        credentialStorageEnabled={false}
        onOpenSecuritySettings={onOpenSecuritySettings}
      />,
    )

    expect(screen.getByRole('note').textContent).toMatch(/当前不会保存此凭据|This credential will not be saved/)
    fireEvent.click(screen.getByRole('button', { name: /前往安全设置|Open Security Settings/ }))
    expect(onOpenSecuritySettings).toHaveBeenCalledTimes(1)
  })

  it('keeps the credential draft while temporarily hidden', () => {
    const modal = (hidden: boolean) => (
      <LanguageProvider>
        <DataProvider><NewConnectionModal onClose={() => {}} hidden={hidden} /></DataProvider>
      </LanguageProvider>
    )
    const { container, rerender } = render(modal(false))
    const secret = container.querySelector<HTMLInputElement>('input[type="password"]')!
    fireEvent.change(secret, { target: { value: 'draft-secret' } })

    rerender(modal(true))
    expect((container.firstElementChild as HTMLElement).style.display).toBe('none')
    rerender(modal(false))
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('draft-secret')
  })

  it('port field rejects non-digit input', () => {
    const { container } = wrap(<NewConnectionModal onClose={() => {}} />)
    const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[]
    const port = inputs.find(i => i.value === '5432')!
    expect(port).toBeTruthy()
    fireEvent.change(port, { target: { value: '12ab34' } })
    expect(port.value).toBe('1234')
  })

  it('invokes testConnection and shows the real version + latency on success', async () => {
    h.testConnection.mockResolvedValue({ version: 'PostgreSQL 16.2 on x86_64', latencyMs: 7 })
    const { container } = wrap(<NewConnectionModal onClose={() => {}} />)
    // Fill required-ish fields.
    const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[]
    const host = inputs.find(i => i.getAttribute('placeholder') === '127.0.0.1')!
    fireEvent.change(host, { target: { value: '127.0.0.1' } })
    // Click 测试连接 (test connection)
    fireEvent.click(screen.getByText('测试连接'))
    expect(h.testConnection).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(screen.getByText(/PostgreSQL 16.2/)).toBeTruthy()
      expect(screen.getByText(/7ms/)).toBeTruthy()
    })
  })

  it('shows the failure label when testConnection rejects', async () => {
    h.testConnection.mockRejectedValue(new Error('connection refused'))
    wrap(<NewConnectionModal onClose={() => {}} />)
    fireEvent.click(screen.getByText('测试连接'))
    await waitFor(() => {
      expect(screen.getByText('测试失败')).toBeTruthy()
      expect(screen.getByText('connection refused')).toBeTruthy()
    })
  })
})

describe('NewConnectionModal — multi-engine catalog', () => {
  beforeEach(() => { h.testConnection.mockReset() })

  it('lists protocol-family variants and JDBC engines in the dropdown', () => {
    wrap(<NewConnectionModal onClose={() => {}} />)
    // open the engine dropdown (trigger shows the current engine, PostgreSQL)
    fireEvent.click(screen.getByText('PostgreSQL'))
    // native protocol-family variants are now selectable…
    expect(screen.getByText('CockroachDB')).toBeTruthy()
    expect(screen.getByText('MariaDB')).toBeTruthy()
    expect(screen.getByText('TiDB')).toBeTruthy()
    expect(screen.getByText('KingbaseES')).toBeTruthy()
    // …and JDBC-sidecar engines too
    expect(screen.getByText('Oracle')).toBeTruthy()
    expect(screen.getByText('IBM Db2')).toBeTruthy()
    expect(screen.getByText('Snowflake')).toBeTruthy()
    // group headers render (i18n)
    expect(screen.getByText('国产数据库')).toBeTruthy()
    expect(screen.getByText('JDBC（需驱动 JAR）')).toBeTruthy()
  })

  it('filters the engine catalog by name and selects the result', () => {
    const { container } = wrap(<NewConnectionModal onClose={() => {}} />)
    fireEvent.click(screen.getByText('PostgreSQL'))

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'mysql' } })

    expect(screen.getByText('MySQL')).toBeTruthy()
    expect(screen.queryByText('Oracle')).toBeNull()
    fireEvent.click(screen.getByText('MySQL'))
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(Array.from(container.querySelectorAll('input')).some(input => input.value === '3306')).toBe(true)
  })

  it('threads the selected variant driverProfile through testConnection', async () => {
    h.testConnection.mockResolvedValue({ version: 'CockroachDB CCL v23', latencyMs: 5 })
    const { container } = wrap(<NewConnectionModal onClose={() => {}} />)
    fireEvent.click(screen.getByText('PostgreSQL'))
    fireEvent.click(screen.getByText('CockroachDB'))
    // port should snap to the engine default (26257)
    const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[]
    expect(inputs.some(i => i.value === '26257')).toBe(true)
    const host = inputs.find(i => i.getAttribute('placeholder') === '127.0.0.1')!
    fireEvent.change(host, { target: { value: '127.0.0.1' } })
    fireEvent.click(screen.getByText('测试连接'))
    await waitFor(() => expect(h.testConnection).toHaveBeenCalledTimes(1))
    expect(h.testConnection.mock.calls[0][0]).toMatchObject({
      dbType: 'postgres', driverProfile: 'cockroachdb',
    })
  })

  it('threads SSL/TLS options (ssl + caCertPath + sslRejectUnauthorized) through testConnection', async () => {
    h.testConnection.mockResolvedValue({ version: 'PostgreSQL 16.2', latencyMs: 6 })
    const { container } = wrap(<NewConnectionModal onClose={() => {}} />)
    const inputs = () => Array.from(container.querySelectorAll('input')) as HTMLInputElement[]
    const host = inputs().find(i => i.getAttribute('placeholder') === '127.0.0.1')!
    fireEvent.change(host, { target: { value: '127.0.0.1' } })
    // enable SSL
    fireEvent.click(screen.getByLabelText('启用 SSL/TLS'))
    // fill CA cert path (revealed only after SSL is on)
    const ca = inputs().find(i => i.getAttribute('placeholder') === '/path/to/ca.pem')!
    fireEvent.change(ca, { target: { value: '/etc/ssl/ca.pem' } })
    // opt out of verification
    fireEvent.click(screen.getByLabelText('不校验服务器证书'))
    fireEvent.click(screen.getByText('测试连接'))
    await waitFor(() => expect(h.testConnection).toHaveBeenCalledTimes(1))
    expect(h.testConnection.mock.calls[0][0]).toMatchObject({
      ssl: true,
      caCertPath: '/etc/ssl/ca.pem',
      sslRejectUnauthorized: false,
    })
  })

  it('omits SSL fields entirely when SSL is left off', async () => {
    h.testConnection.mockResolvedValue({ version: 'PostgreSQL 16.2', latencyMs: 6 })
    const { container } = wrap(<NewConnectionModal onClose={() => {}} />)
    const host = (Array.from(container.querySelectorAll('input')) as HTMLInputElement[])
      .find(i => i.getAttribute('placeholder') === '127.0.0.1')!
    fireEvent.change(host, { target: { value: '127.0.0.1' } })
    fireEvent.click(screen.getByText('测试连接'))
    await waitFor(() => expect(h.testConnection).toHaveBeenCalledTimes(1))
    const args = h.testConnection.mock.calls[0][0]
    expect('ssl' in args).toBe(false)
    expect('caCertPath' in args).toBe(false)
    expect('sslRejectUnauthorized' in args).toBe(false)
  })

  it('shows the JDBC driver row with a download button for a downloadable engine', async () => {
    wrap(<NewConnectionModal onClose={() => {}} />)
    fireEvent.click(screen.getByText('PostgreSQL'))
    fireEvent.click(screen.getByText('Oracle'))
    // Oracle has a Maven download → driver row offers "下载驱动".
    await waitFor(() => expect(screen.getByText('下载驱动')).toBeTruthy())
    expect(screen.getByText('JDBC 驱动未安装')).toBeTruthy()
  })

  it('shows a download button for 达梦 (now on Maven Central)', async () => {
    wrap(<NewConnectionModal onClose={() => {}} />)
    fireEvent.click(screen.getByText('PostgreSQL'))
    fireEvent.click(screen.getByText('达梦 DM'))
    // 达梦驱动已在 Maven Central → 显示下载按钮。
    await waitFor(() => expect(screen.getByText('下载驱动')).toBeTruthy())
  })

  it('shows a manual hint (no download button) for a proprietary engine', async () => {
    wrap(<NewConnectionModal onClose={() => {}} />)
    fireEvent.click(screen.getByText('PostgreSQL'))
    fireEvent.click(screen.getByText('Cassandra'))
    // Cassandra 无自包含 Maven jar → 手动提示，无下载按钮。
    await waitFor(() => expect(screen.getByText('需手动提供驱动 JAR')).toBeTruthy())
    expect(screen.queryByText('下载驱动')).toBeNull()
  })

  it('threads a JDBC engine as dbType=jdbc + its driverProfile', async () => {
    h.testConnection.mockResolvedValue({ version: 'Oracle 21c', latencyMs: 9 })
    const { container } = wrap(<NewConnectionModal onClose={() => {}} />)
    fireEvent.click(screen.getByText('PostgreSQL'))
    fireEvent.click(screen.getByText('Oracle'))
    const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[]
    const host = inputs.find(i => i.getAttribute('placeholder') === '127.0.0.1')!
    fireEvent.change(host, { target: { value: '127.0.0.1' } })
    fireEvent.click(screen.getByText('测试连接'))
    await waitFor(() => expect(h.testConnection).toHaveBeenCalledTimes(1))
    expect(h.testConnection.mock.calls[0][0]).toMatchObject({
      dbType: 'jdbc', driverProfile: 'oracle',
    })
  })
})

describe('NewConnectionModal — create mode', () => {
  beforeEach(() => {
    h.saveProfile.mockClear()
    h.saveDbConnection.mockReset()
    h.dbConnect.mockReset()
    h.sshTest.mockReset()
  })

  it('starts with EMPTY defaults (no prototype sample values)', () => {
    wrap(<NewConnectionModal onClose={() => {}} onConnect={() => {}} />)
    // host/SSH tab so the host fields are visible
    fireEvent.click(screen.getByText('主机 / 终端'))
    const name = screen.getByText('名称').parentElement!.querySelector('input') as HTMLInputElement
    const host = screen.getByText('主机').parentElement!.querySelector('input') as HTMLInputElement
    expect(name.value).toBe('')
    expect(host.value).toBe('')
    const user = screen.getByText('用户名').parentElement!.querySelector('input') as HTMLInputElement
    expect(user.value).toBe('')
    // No prototype sample values anywhere.
    expect(screen.queryByDisplayValue('prod-web-01')).toBeNull()
    expect(screen.queryByDisplayValue('10.0.1.21')).toBeNull()
    expect(screen.queryByDisplayValue('deploy')).toBeNull()
    expect(screen.queryByDisplayValue('catio')).toBeNull()
    // Port resets to the sensible SSH default on the host tab.
    const port = screen.getByText('端口').parentElement!.querySelector('input') as HTMLInputElement
    expect(port.value).toBe('22')
  })

  it('Test button calls sshTest and renders the real result', async () => {
    h.sshTest.mockResolvedValue({ ok: true, latencyMs: 17 })
    wrap(<NewConnectionModal onClose={() => {}} onConnect={() => {}} />)
    fireEvent.click(screen.getByText('主机 / 终端'))
    const host = screen.getByText('主机').parentElement!.querySelector('input') as HTMLInputElement
    const user = screen.getByText('用户名').parentElement!.querySelector('input') as HTMLInputElement
    fireEvent.input(host, { target: { value: '1.2.3.4' } })
    fireEvent.input(user, { target: { value: 'root' } })
    fireEvent.click(screen.getByText('测试连接'))
    expect(h.sshTest).toHaveBeenCalledTimes(1)
    expect(h.sshTest.mock.calls[0][0]).toMatchObject({ host: '1.2.3.4', user: 'root' })
    await waitFor(() => expect(screen.getByText(/测试通过 · 17ms/)).toBeTruthy())
  })

  it('ProxyJump toggle is OFF by default and reveals jump fields when ON', () => {
    wrap(<NewConnectionModal onClose={() => {}} onConnect={() => {}} />)
    fireEvent.click(screen.getByText('主机 / 终端'))
    // Jump fields not shown initially
    expect(screen.queryByText('跳板主机')).toBeNull()
    // Toggle ProxyJump ON
    const toggleBtn = screen.getByRole('switch')
    fireEvent.click(toggleBtn)
    // Jump fields should now be visible
    expect(screen.getByText('跳板主机')).toBeTruthy()
    expect(screen.getByText('跳板用户')).toBeTruthy()
    expect(screen.getByText('跳板密码/口令')).toBeTruthy()
  })

  it('Save&Connect includes jump in args (with secret) and saves profile WITHOUT jump secret', () => {
    const onConnect = vi.fn()
    wrap(<NewConnectionModal onClose={() => {}} onConnect={onConnect} />)
    fireEvent.click(screen.getByText('主机 / 终端'))

    // Fill target fields
    const host = screen.getByText('主机').parentElement!.querySelector('input') as HTMLInputElement
    const user = screen.getByText('用户名').parentElement!.querySelector('input') as HTMLInputElement
    fireEvent.input(host, { target: { value: '10.0.0.5' } })
    fireEvent.input(user, { target: { value: 'app' } })

    // Enable ProxyJump
    const toggleBtn = screen.getByRole('switch')
    fireEvent.click(toggleBtn)

    // Fill jump fields
    const jumpHost = screen.getByText('跳板主机').parentElement!.querySelector('input') as HTMLInputElement
    const jumpUser = screen.getByText('跳板用户').parentElement!.querySelector('input') as HTMLInputElement
    fireEvent.input(jumpHost, { target: { value: 'bastion.example.com' } })
    fireEvent.input(jumpUser, { target: { value: 'ec2-user' } })

    // Fill jump secret (placeholder is the proxyJumpSecret i18n key: '跳板密码/口令')
    const jumpSecretInput = screen.getByPlaceholderText('跳板密码/口令') as HTMLInputElement
    fireEvent.change(jumpSecretInput, { target: { value: 'jump-pw-123' } })

    // Click Save & Connect
    fireEvent.click(screen.getByText('保存并连接'))

    // onConnect args should carry jump with secret
    expect(onConnect).toHaveBeenCalledTimes(1)
    const [args] = onConnect.mock.calls[0] as [import('../../services/ssh').SshConnectArgs, unknown]
    expect(args.jump).toBeDefined()
    expect(args.jump?.host).toBe('bastion.example.com')
    expect(args.jump?.user).toBe('ec2-user')
    expect(args.jump?.secret).toBe('jump-pw-123')

    // saveProfile should be called WITHOUT jump secret
    expect(h.saveProfile).toHaveBeenCalledTimes(1)
    const savedProfile = h.saveProfile.mock.calls[0][0] as ConnectionProfile
    expect(savedProfile.jump?.host).toBe('bastion.example.com')
    expect(JSON.stringify(savedProfile)).not.toContain('jump-pw-123')
    // jump.secret should not be in the saved profile
    expect(JSON.stringify(savedProfile)).not.toContain('"secret"')
  })

  it('Save&Connect persists host notes on the saved profile', () => {
    const onConnect = vi.fn()
    wrap(<NewConnectionModal onClose={() => {}} onConnect={onConnect} />)
    fireEvent.click(screen.getByText('主机 / 终端'))

    const host = screen.getByText('主机').parentElement!.querySelector('input') as HTMLInputElement
    const user = screen.getByText('用户名').parentElement!.querySelector('input') as HTMLInputElement
    const notes = screen.getByText('备注').parentElement!.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.input(host, { target: { value: '10.0.0.8' } })
    fireEvent.input(user, { target: { value: 'deploy' } })
    fireEvent.change(notes, { target: { value: '生产主机，密码提示看团队 vault 条目 A' } })

    fireEvent.click(screen.getByText('保存并连接'))

    expect(h.saveProfile).toHaveBeenCalledTimes(1)
    expect(h.saveProfile.mock.calls[0][0]).toMatchObject({
      id: 'live-10.0.0.8:22-deploy',
      notes: '生产主机，密码提示看团队 vault 条目 A',
    })
  })

  it('Save&Connect persists DB notes on the saved profile', () => {
    h.dbConnect.mockImplementation(() => new Promise(() => {}))
    wrap(<NewConnectionModal onClose={() => {}} />)

    const name = screen.getByText('名称').parentElement!.querySelector('input') as HTMLInputElement
    const host = screen.getByText('主机').parentElement!.querySelector('input') as HTMLInputElement
    const user = screen.getByText('用户').parentElement!.querySelector('input') as HTMLInputElement
    const notes = screen.getByText('备注').parentElement!.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(name, { target: { value: 'orders-prod' } })
    fireEvent.change(host, { target: { value: '127.0.0.1' } })
    fireEvent.change(user, { target: { value: 'app_ro' } })
    fireEvent.change(notes, { target: { value: '只读账号，密码提示：轮换批次 2026Q3' } })

    fireEvent.click(screen.getByText('保存并连接'))

    expect(h.saveDbConnection).toHaveBeenCalledTimes(1)
    expect(h.saveDbConnection.mock.calls[0][0]).toMatchObject({
      id: 'db-generated-id',
      name: 'orders-prod',
      notes: '只读账号，密码提示：轮换批次 2026Q3',
    })
  })
})

describe('NewConnectionModal — 本地终端', () => {
  beforeEach(() => { h.saveProfile.mockClear() })

  it('选中「本地」协议后隐藏主机/端口/用户名/密码字段', () => {
    wrap(<NewConnectionModal onClose={() => {}} onOpenTerminal={() => {}} />)
    fireEvent.click(screen.getByText('主机 / 终端'))
    // 切到本地协议。
    fireEvent.click(screen.getByText('本地'))
    // 本地终端不应显示这些 SSH 字段。
    expect(screen.queryByText('主机')).toBeNull()
    expect(screen.queryByText('端口')).toBeNull()
    expect(screen.queryByText('用户名')).toBeNull()
    expect(screen.queryByPlaceholderText('密码')).toBeNull()
    // 名称与分组仍在。
    expect(screen.getByText('名称')).toBeTruthy()
    expect(screen.getByText('分组')).toBeTruthy()
  })

  it('保存本地连接:持久化 proto=local 的 profile 且不含认证字段', () => {
    const onOpenTerminal = vi.fn()
    const onClose = vi.fn()
    wrap(<NewConnectionModal onClose={onClose} onOpenTerminal={onOpenTerminal} />)
    fireEvent.click(screen.getByText('主机 / 终端'))
    fireEvent.click(screen.getByText('本地'))
    const name = screen.getByText('名称').parentElement!.querySelector('input') as HTMLInputElement
    fireEvent.input(name, { target: { value: '本机' } })
    fireEvent.click(screen.getByText('连接'))
    // 应持久化 profile 以便进 Vault、可复用。
    expect(h.saveProfile).toHaveBeenCalledTimes(1)
    const saved = h.saveProfile.mock.calls[0][0] as ConnectionProfile
    expect(saved).toMatchObject({ name: '本机', proto: 'local' })
    // 认证字段为占位空值,不泄漏用户名/主机。
    expect(saved.host).toBe('')
    expect(saved.user).toBe('')
    // 同时打开本地终端标签。
    expect(onOpenTerminal).toHaveBeenCalledWith({ proto: 'local', name: '本机' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('NewConnectionModal — edit mode', () => {
  beforeEach(() => { h.saveProfile.mockClear(); h.sshTest.mockReset() })

  it('leaves the password field empty in edit mode (secrets never stored)', () => {
    wrap(<NewConnectionModal editProfile={PROFILE} onClose={() => {}} />)
    const pw = screen.getByPlaceholderText('密码') as HTMLInputElement
    expect(pw.value).toBe('')
  })

  it('renders the edit title and prefills fields from the profile', () => {
    wrap(<NewConnectionModal editProfile={PROFILE} onClose={() => {}} />)
    expect(screen.getByText('编辑连接')).toBeTruthy()
    expect((screen.getByDisplayValue('my-server') as HTMLInputElement)).toBeTruthy()
    expect((screen.getByDisplayValue('1.2.3.4') as HTMLInputElement)).toBeTruthy()
    expect((screen.getByDisplayValue('2222') as HTMLInputElement)).toBeTruthy()
    expect((screen.getByDisplayValue('deploy') as HTMLInputElement)).toBeTruthy()
  })

  it('Save updates the SAME id, calls onSaved, and does NOT call onConnect', () => {
    const onSaved = vi.fn()
    const onConnect = vi.fn()
    const onClose = vi.fn()
    wrap(<NewConnectionModal editProfile={PROFILE} onSaved={onSaved} onConnect={onConnect} onClose={onClose} />)
    fireEvent.click(screen.getByText('保存'))
    expect(h.saveProfile).toHaveBeenCalledTimes(1)
    expect(h.saveProfile.mock.calls[0][0]).toMatchObject({ id: 'live-1.2.3.4:22-deploy', name: 'my-server', host: '1.2.3.4', port: 2222, user: 'deploy' })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onConnect).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('prefills jump fields from editProfile.jump (no secret)', () => {
    wrap(<NewConnectionModal editProfile={PROFILE_WITH_JUMP} onClose={() => {}} />)
    // Toggle should be ON because profile has jump
    expect(screen.getByText('跳板主机')).toBeTruthy()
    expect(screen.getByDisplayValue('bastion.example.com')).toBeTruthy()
    expect(screen.getByDisplayValue('ec2-user')).toBeTruthy()
    // Jump secret should be empty (never prefilled)
    const jumpSecretInputs = document.querySelectorAll('input[type="password"]')
    jumpSecretInputs.forEach(inp => {
      expect((inp as HTMLInputElement).value).toBe('')
    })
  })

  it('Save in edit mode persists jump profile WITHOUT secret', () => {
    const onSaved = vi.fn()
    const onClose = vi.fn()
    wrap(<NewConnectionModal editProfile={PROFILE_WITH_JUMP} onSaved={onSaved} onClose={onClose} />)
    fireEvent.click(screen.getByText('保存'))
    expect(h.saveProfile).toHaveBeenCalledTimes(1)
    const saved = h.saveProfile.mock.calls[0][0] as ConnectionProfile
    expect(saved.jump?.host).toBe('bastion.example.com')
    expect(saved.jump?.user).toBe('ec2-user')
    // No secret in saved profile
    expect(JSON.stringify(saved)).not.toContain('"secret"')
    expect(onSaved).toHaveBeenCalledTimes(1)
  })
})
