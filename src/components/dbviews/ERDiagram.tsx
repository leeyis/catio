/* ported from ref-ui/_extract/blob5.txt — verbatim per plan T1-T7 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn } from '../atoms'
import { useData } from '../../state/DataContext'
import type { ErRelation } from '../../services/types'

export interface ERDiagramProps {
  onOpenTable?: (table: string) => void
}

export function ERDiagram({ onOpenTable }: ERDiagramProps) {
  const { t } = useTranslation()
  const D = useData()
  const er = D.erModel
  const [zoom, setZoom] = useState(1)
  const CARD_W = 188, HEAD_H = 34, ROW_H = 22, PAD = 6
  const geom: Record<string, { x: number; y: number; w: number; h: number; cols: typeof D.tableStructures[string]['columns'] }> = {}
  er.tables.forEach(t => {
    const st = D.tableStructures[t.name]
    const cols = st ? st.columns : []
    geom[t.name] = { x: t.x, y: t.y, w: CARD_W, h: HEAD_H + PAD * 2 + cols.length * ROW_H, cols }
  })

  function colY(table: string, colName: string) {
    const g = geom[table]; if (!g) return 0
    const idx = Math.max(0, g.cols.findIndex(c => c.name === colName))
    return g.y + HEAD_H + PAD + idx * ROW_H + ROW_H / 2
  }

  function path(rel: ErRelation) {
    const s = geom[rel.from], t = geom[rel.to]
    if (!s || !t) return ''
    const sy = colY(rel.from, rel.fromCol), ty = colY(rel.to, rel.toCol)
    const sLeft = s.x + s.w / 2 > t.x + t.w / 2
    const sx = sLeft ? s.x : s.x + s.w
    const tx = sLeft ? t.x + t.w : t.x
    const dx = Math.max(40, Math.abs(tx - sx) * 0.5)
    const c1 = sLeft ? sx - dx : sx + dx
    const c2 = sLeft ? tx + dx : tx - dx
    return `M ${sx} ${sy} C ${c1} ${sy}, ${c2} ${ty}, ${tx} ${ty}`
  }

  const W = 980, H = 760
  return (
    <div className="col" style={{ height: '100%', minHeight: 0 }}>
      <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', gap: 8, flex: 'none' }}>
        <span className="chip" style={{ background: 'var(--surface-sunken)' }}><Icon name="network" size={12} /> public · {er.tables.length} {t('dbviews.erTables')} · {er.relations.length} {t('dbviews.erRelations')}</span>
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
        <div style={{ width: W * zoom, height: H * zoom, position: 'relative' }}>
          <div style={{ width: W, height: H, position: 'relative', transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
            <svg width={W} height={H} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              <defs>
                <marker id="erdot" markerWidth="8" markerHeight="8" refX="4" refY="4"><circle cx="4" cy="4" r="3" fill="var(--accent-primary)" /></marker>
              </defs>
              {er.relations.map((rel, i) => (
                <path key={i} d={path(rel)} fill="none" stroke="var(--accent-primary)" strokeWidth="1.6" opacity="0.55" markerStart="url(#erdot)" markerEnd="url(#erdot)" />
              ))}
            </svg>
            {er.tables.map(t => {
              const g = geom[t.name]
              return (
                <div key={t.name} onDoubleClick={() => onOpenTable && onOpenTable(t.name)}
                  style={{ position: 'absolute', left: g.x, top: g.y, width: CARD_W, background: 'var(--surface-card)', border: '1px solid var(--border-hairline-alt)', borderRadius: 10, boxShadow: 'var(--shadow-card)', overflow: 'hidden' }}>
                  <div className="row gap6" style={{ height: HEAD_H, padding: '0 10px', background: 'var(--accent-soft-alt)', borderBottom: '1px solid var(--accent-border)' }}>
                    <Icon name="table-2" size={13} style={{ color: 'var(--accent-primary)' }} />
                    <span className="mono" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--accent-primary)' }}>{t.name}</span>
                  </div>
                  <div style={{ padding: `${PAD}px 0` }}>
                    {g.cols.map(c => (
                      <div key={c.name} className="row" style={{ height: ROW_H, padding: '0 10px', gap: 6, fontSize: 11.5 }}>
                        <Icon name={c.key === 'PK' ? 'key' : c.key === 'FK' ? 'link' : 'hash'} size={11} style={{ color: c.key === 'PK' ? 'var(--signal-amber)' : c.key === 'FK' ? 'var(--signal-blue)' : 'var(--text-disabled)', flex: 'none' }} />
                        <span className="mono" style={{ color: 'var(--text-secondary)', fontWeight: c.key ? 600 : 400 }}>{c.name}</span>
                        <span className="grow" />
                        <span className="mono" style={{ color: 'var(--text-faint)', fontSize: 10.5 }}>{c.type.replace(/\(.*\)/, '')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
