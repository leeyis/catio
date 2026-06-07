import { highlightSQL } from '../src/components/dbviews/highlightSQL'
it('wraps keywords in colored spans', () => {
  const out = highlightSQL('select * from orders')
  expect(out).toContain('var(--accent-primary)')
  expect(out).toContain('orders')
})
