/* ported from ref-ui/_extract/blob5.txt — verbatim per plan T1-T7; live-connection ER data path added */
import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn } from '../atoms'
import { useData } from '../../state/DataContext'
import { erRelations, schemaColumns } from '../../services/db'
import type { ErRelation } from '../../services/types'

export interface ERDiagramProps {
  onOpenTable?: (table: string) => void
  /** Live connection id. When set, the diagram is built from the real schema. */
  connId?: string
  /** Schema/namespace name whose tables + relations are drawn (live path). */
  schema?: string
}

/** A column as the diagram needs it: name + optional type + key role. */
interface ErCol { name: string; type: string; key?: 'PK' | 'FK' | '' }
/** A laid-out table card. */
interface ErCard { name: string; x: number; y: number; cols: ErCol[] }

const CARD_W = 188, HEAD_H = 34, ROW_H = 22, PAD = 6

export function ERDiagram({ onOpenTable, connId, schema }: ERDiagramProps) {
  const { t } = useTranslation()
  const D = useData()
  const [zoom, setZoom] = useState(1)

  // ---- Live data (only fetched when connected) ----
  const [liveCols, setLiveCols] = useState<[string, string[]][] | null>(null)
  const [liveRels, setLiveRels] = useState<ErRelation[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!connId || !schema) { setLiveCols(null); setLiveRels(null); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    Promise.all([schemaColumns(connId, schema), erRelations(connId, schema)])
      .then(([cols, rels]) => { if (!cancelled) { setLiveCols(cols); setLiveRels(rels) } })
      .catch(() => { if (!cancelled) { setLiveCols([]); setLiveRels([]) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [connId, schema])

  const isLive = !!connId && !!schema

  // ---- Build the (table, relation) model + auto-layout for the live path ----
  // Mock path keeps the seeded x/y; live path lays cards out on a grid.
  const { cards, relations } = useMemo<{ cards: ErCard[]; relations: ErRelation[] }>(() => {
    if (!isLive) {
      const rels = D.erModel.relations
      const cs: ErCard[] = D.erModel.tables.map(tb => {
        const st = D.tableStructures[tb.name]
        const cols: ErCol[] = (st ? st.columns : []).map(c => ({
          name: c.name, type: c.type, key: c.key === 'PK' ? 'PK' : c.key === 'FK' ? 'FK' : '',
        }))
        return { name: tb.name, x: tb.x, y: tb.y, cols }
      })
      return { cards: cs, relations: rels }
    }

    const rels = liveRels ?? []
    const cols = liveCols ?? []
    // Mark columns that participate in a relation: fromCol → FK, toCol → PK (best effort).
    const fkCols = new Set<string>()  // `${table}.${col}`
    const pkCols = new Set<string>()
    rels.forEach(r => { fkCols.add(`${r.from}.${r.fromCol}`); pkCols.add(`${r.to}.${r.toCol}`) })

    // Grid auto-layout: N columns wide, gaps based on the tallest card per row.
    const GRID_COLS = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(cols.length || 1))))
    const GAP_X = 64, GAP_Y = 48, ORIGIN = 24
    const cardH = (n: number) => HEAD_H + PAD * 2 + n * ROW_H

    const cs: ErCard[] = []
    let rowTop = ORIGIN
    let rowMaxH = 0
    cols.forEach(([table, colNames], i) => {
      const c = i % GRID_COLS
      if (c === 0 && i > 0) { rowTop += rowMaxH + GAP_Y; rowMaxH = 0 }
      const ercols: ErCol[] = colNames.map(name => ({
        name,
        type: '',
        key: fkCols.has(`${table}.${name}`) ? 'FK' : pkCols.has(`${table}.${name}`) ? 'PK' : '',
      }))
      const h = cardH(ercols.length)
      rowMaxH = Math.max(rowMaxH, h)
      cs.push({ name: table, x: ORIGIN + c * (CARD_W + GAP_X), y: rowTop, cols: ercols })
    })
    return { cards: cs, relations: rels }
  }, [isLive, liveCols, liveRels, D.erModel, D.tableStructures])

  // ---- Geometry derived from the laid-out cards ----
  const geom = useMemo(() => {
    const g: Record<string, ErCard & { w: number; h: number }> = {}
    cards.forEach(c => { g[c.name] = { ...c, w: CARD_W, h: HEAD_H + PAD * 2 + c.cols.length * ROW_H } })
    return g
  }, [cards])

  function colY(table: string, colName: string) {
    const c = geom[table]; if (!c) return 0
    const idx = Math.max(0, c.cols.findIndex(col => col.name === colName))
    return c.y + HEAD_H + PAD + idx * ROW_H + ROW_H / 2
  }

  function path(rel: ErRelation) {
    const s = geom[rel.from], tt = geom[rel.to]
    if (!s || !tt) return ''
    const sy = colY(rel.from, rel.fromCol), ty = colY(rel.to, rel.toCol)
    const sLeft = s.x + s.w / 2 > tt.x + tt.w / 2
    const sx = sLeft ? s.x : s.x + s.w
    const tx = sLeft ? tt.x + tt.w : tt.x
    const dx = Math.max(40, Math.abs(tx - sx) * 0.5)
    const c1 = sLeft ? sx - dx : sx + dx
    const c2 = sLeft ? tx + dx : tx - dx
    return `M ${sx} ${sy} C ${c1} ${sy}, ${c2} ${ty}, ${tx} ${ty}`
  }

  // Canvas size: grow to fit the laid-out cards (live path) or keep the demo size.
  const { W, H } = useMemo(() => {
    if (!isLive) return { W: 980, H: 760 }
    let maxX = 0, maxY = 0
    cards.forEach(c => {
      maxX = Math.max(maxX, c.x + CARD_W)
      maxY = Math.max(maxY, c.y + HEAD_H + PAD * 2 + c.cols.length * ROW_H)
    })
    return { W: Math.max(980, maxX + 24), H: Math.max(760, maxY + 24) }
  }, [isLive, cards])

  const showEmpty = isLive && !loading && cards.length === 0
  const showLoading = isLive && loading

  return (
    <div className="col" style={{ height: '100%', minHeight: 0 }}>
      <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', gap: 8, flex: 'none' }}>
        <span className="chip" style={{ background: 'var(--surface-sunken)' }}><Icon name="network" size={12} /> {isLive ? schema : 'public'} · {cards.length} {t('dbviews.erTables')} · {relations.length} {t('dbviews.erRelations')}</span>
        <div className="grow" />
        <div className="row gap4">
          <button className="icon-btn bare" onClick={() => setZoom(z => Math.max(0.5, +(z - 0.1).toFixed(2)))} title={t('dbviews.zoomOut')}><Icon name="minus" size={15} /></button>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-tertiary)', minWidth: 40, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
          <button className="icon-btn bare" onClick={() => setZoom(z => Math.min(1.6, +(z + 0.1).toFixed(2)))} title={t('dbviews.zoomIn')}><Icon name="plus" size={15} /></button>
          <button className="icon-btn bare" onClick={() => setZoom(1)} title={t('dbviews.zoomReset')}><Icon name="maximize-2" size={14} /></button>
        </div>
        <Btn size="sm" variant="secondary" icon="download">{t('dbviews.exportPng')}</Btn>
      </div>
      <div className="grow" style={{ overflow: 'auto', background: 'var(--surface-subtle)', backgroundImage: 'radial-gradient(var(--border-hairline) 1px, transparent 1px)', backgroundSize: '22px 22px' }}>
        {(showLoading || showEmpty) ? (
          <div className="col" style={{ height: '100%', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--text-tertiary)' }}>
            <Icon name={showLoading ? 'loader' : 'network'} size={22} style={{ opacity: 0.6 }} />
            <span style={{ fontSize: 12.5 }}>{showLoading ? t('dbviews.erLoading') : t('dbviews.erEmpty')}</span>
          </div>
        ) : (
          <div style={{ width: W * zoom, height: H * zoom, position: 'relative' }}>
            <div style={{ width: W, height: H, position: 'relative', transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
              <svg width={W} height={H} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                <defs>
                  <marker id="erdot" markerWidth="8" markerHeight="8" refX="4" refY="4"><circle cx="4" cy="4" r="3" fill="var(--accent-primary)" /></marker>
                </defs>
                {relations.map((rel, i) => (
                  <path key={i} d={path(rel)} fill="none" stroke="var(--accent-primary)" strokeWidth="1.6" opacity="0.55" markerStart="url(#erdot)" markerEnd="url(#erdot)" />
                ))}
              </svg>
              {cards.map(card => {
                const g = geom[card.name]
                return (
                  <div key={card.name} onDoubleClick={() => onOpenTable && onOpenTable(card.name)}
                    style={{ position: 'absolute', left: g.x, top: g.y, width: CARD_W, background: 'var(--surface-card)', border: '1px solid var(--border-hairline-alt)', borderRadius: 10, boxShadow: 'var(--shadow-card)', overflow: 'hidden' }}>
                    <div className="row gap6" style={{ height: HEAD_H, padding: '0 10px', background: 'var(--accent-soft-alt)', borderBottom: '1px solid var(--accent-border)' }}>
                      <Icon name="table-2" size={13} style={{ color: 'var(--accent-primary)' }} />
                      <span className="mono" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--accent-primary)' }}>{card.name}</span>
                    </div>
                    <div style={{ padding: `${PAD}px 0` }}>
                      {card.cols.map(c => (
                        <div key={c.name} className="row" style={{ height: ROW_H, padding: '0 10px', gap: 6, fontSize: 11.5 }}>
                          <Icon name={c.key === 'PK' ? 'key' : c.key === 'FK' ? 'link' : 'hash'} size={11} style={{ color: c.key === 'PK' ? 'var(--signal-amber)' : c.key === 'FK' ? 'var(--signal-blue)' : 'var(--text-disabled)', flex: 'none' }} />
                          <span className="mono" style={{ color: 'var(--text-secondary)', fontWeight: c.key ? 600 : 400 }}>{c.name}</span>
                          <span className="grow" />
                          {c.type && <span className="mono" style={{ color: 'var(--text-faint)', fontSize: 10.5 }}>{c.type.replace(/\(.*\)/, '')}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
