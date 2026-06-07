import { buildSidebarTree } from '../src/components/shell/Sidebar'
import { DATA } from '../src/services/mockData'
it('nests tunneled dbs under their bastion host', () => {
  const prod = DATA.connections.filter(c => c.group === 'prod')
  const tree = buildSidebarTree(prod, 'all')
  const bastion = tree.find(n => 'nested' in n && n.nested && n.host.id === 'h-bastion')
  expect(bastion).toBeTruthy()
  expect((bastion as any).dbs.map((d: {id:string}) => d.id)).toContain('d-orders')
})
