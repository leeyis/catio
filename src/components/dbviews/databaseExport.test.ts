import { describe, it, expect } from 'vitest'
import {
  filterTables,
  toggleSelected,
  selectAllFiltered,
  clearFiltered,
  buildSelectedTablesPayload,
  exportReady,
} from './databaseExport'

describe('databaseExport pure logic', () => {
  const ALL = ['orders', 'order_items', 'customers', 'leads']

  describe('filterTables', () => {
    it('returns every table when the query is blank', () => {
      expect(filterTables(ALL, '')).toEqual(ALL)
      expect(filterTables(ALL, '   ')).toEqual(ALL)
    })
    it('case-insensitively filters by substring', () => {
      expect(filterTables(ALL, 'ORDER')).toEqual(['orders', 'order_items'])
      expect(filterTables(ALL, 'lead')).toEqual(['leads'])
    })
  })

  describe('toggleSelected', () => {
    it('adds an unselected table (preserving the canonical table order)', () => {
      expect(toggleSelected(ALL, ['customers'], 'orders')).toEqual(['orders', 'customers'])
    })
    it('removes an already-selected table', () => {
      expect(toggleSelected(ALL, ['orders', 'customers'], 'orders')).toEqual(['customers'])
    })
  })

  describe('selectAllFiltered', () => {
    it('adds every currently-filtered table to the selection (union, canonical order)', () => {
      const filtered = filterTables(ALL, 'order') // orders, order_items
      expect(selectAllFiltered(ALL, ['leads'], filtered)).toEqual(['orders', 'order_items', 'leads'])
    })
  })

  describe('clearFiltered', () => {
    it('removes only the filtered tables, leaving the rest selected', () => {
      const filtered = filterTables(ALL, 'order') // orders, order_items
      expect(clearFiltered(['orders', 'order_items', 'leads'], filtered)).toEqual(['leads'])
    })
  })

  describe('buildSelectedTablesPayload', () => {
    it('returns undefined ("all tables") when every table is selected', () => {
      expect(buildSelectedTablesPayload(ALL, [...ALL])).toBeUndefined()
    })
    it('returns the explicit subset (canonical order) when a strict subset is selected', () => {
      expect(buildSelectedTablesPayload(ALL, ['leads', 'orders'])).toEqual(['orders', 'leads'])
    })
    it('returns undefined when there are no tables at all', () => {
      expect(buildSelectedTablesPayload([], [])).toBeUndefined()
    })
  })

  describe('exportReady', () => {
    it('is false with no selected tables', () => {
      expect(exportReady({ selectedCount: 0, includeStructure: true, includeData: true })).toBe(false)
    })
    it('is false when neither structure nor data is included', () => {
      expect(exportReady({ selectedCount: 3, includeStructure: false, includeData: false })).toBe(false)
    })
    it('is true with at least one table and at least one of structure/data', () => {
      expect(exportReady({ selectedCount: 1, includeStructure: true, includeData: false })).toBe(true)
      expect(exportReady({ selectedCount: 1, includeStructure: false, includeData: true })).toBe(true)
    })
  })
})
