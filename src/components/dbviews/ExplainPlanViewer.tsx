/**
 * 执行计划查看器(树 / 摘要表 / JSON 三视图)。
 * React 移植自 dbx apps/desktop/src/components/explain/ExplainPlanViewer.vue,
 * 数据来自 explainPlan.ts 的纯函数解析。遵循 Catio 现有内联样式 + CSS 变量主题约定
 * (与 SqlConsole 一致),不硬编码颜色,主题切换正常。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import type { ParsedExplainPlan, ExplainPlanNode } from './explainPlan'
import { flattenExplainPlanNodes } from './explainPlan'

export interface ExplainPlanViewerProps {
  plan?: ParsedExplainPlan
  error?: string
  loading?: boolean
  /** 可选的关闭入口(嵌入 SqlConsole 结果区时,用于回到普通结果)。 */
  onClose?: () => void
}

type ViewMode = 'tree' | 'summary' | 'json'

/** 把树压平成 { node, depth } 行,供摘要表缩进展示。 */
function flatRows(nodes: ExplainPlanNode[]): Array<{ node: ExplainPlanNode; depth: number }> {
  const rows: Array<{ node: ExplainPlanNode; depth: number }> = []
  const visit = (node: ExplainPlanNode, depth: number) => {
    rows.push({ node, depth })
    node.children.forEach(child => visit(child, depth + 1))
  }
  nodes.forEach(node => visit(node, 0))
  return rows
}

function TreeNode({ node, depth }: { node: ExplainPlanNode; depth: number }) {
  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 16 }}>
      <div className="col" style={{
        gap: 3, padding: '7px 10px', borderRadius: 9,
        border: '1px solid var(--border-hairline)', background: 'var(--surface-sunken)',
      }}>
        <div className="row gap6" style={{ alignItems: 'center' }}>
          <Icon name="box" size={13} style={{ color: 'var(--accent-primary)', flex: 'none' }} />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{node.title}</span>
          {node.cost && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: "'Geist Mono', monospace" }}>
              cost {node.cost}
            </span>
          )}
          {node.rows && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: "'Geist Mono', monospace" }}>
              rows {node.rows}
            </span>
          )}
        </div>
        {(node.index || node.details.length > 0) && (
          <div className="col" style={{ gap: 2, fontSize: 11, color: 'var(--text-tertiary)' }}>
            {node.index && <span>index {node.index}</span>}
            {node.details.map((d, i) => <span key={i}>{d}</span>)}
          </div>
        )}
      </div>
      {node.children.length > 0 && (
        <div className="col" style={{ gap: 6, marginTop: 6 }}>
          {node.children.map(child => <TreeNode key={child.id} node={child} depth={depth + 1} />)}
        </div>
      )}
    </div>
  )
}

export function ExplainPlanViewer({ plan, error, loading, onClose }: ExplainPlanViewerProps) {
  const { t } = useTranslation()
  const [view, setView] = useState<ViewMode>('tree')

  const nodeCount = plan ? flattenExplainPlanNodes(plan.nodes).length : 0
  const rawJson = plan ? JSON.stringify(plan.raw, null, 2) : ''
  const rows = plan ? flatRows(plan.nodes) : []

  const tabBtn = (mode: ViewMode, label: string, icon: string, testId: string) => (
    <button
      data-testid={testId}
      className="icon-btn bare"
      onClick={() => setView(mode)}
      title={label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 8px',
        fontSize: 11, borderRadius: 7, whiteSpace: 'nowrap', flex: 'none',
        background: view === mode ? 'var(--surface-raised)' : 'transparent',
        color: view === mode ? 'var(--text-primary)' : 'var(--text-tertiary)',
      }}
    >
      <Icon name={icon} size={13} />{label}
    </button>
  )

  return (
    <div className="col" style={{ height: '100%', minHeight: 0, width: '100%', background: 'var(--surface-base)' }}>
      {/* 工具条:标题 + 引擎/节点数 + 视图切换 + 关闭 */}
      <div className="row" style={{
        flex: 'none', height: 34, padding: '0 10px', gap: 8, alignItems: 'center',
        borderBottom: '1px solid var(--border-hairline)', fontSize: 12,
      }}>
        {/* 左侧标题 + 引擎信息:整体可收缩,引擎信息 ellipsis,窄宽时不挤压右侧切换/关闭 */}
        <div className="row gap8" style={{ flex: 1, minWidth: 0, alignItems: 'center', overflow: 'hidden' }}>
          <span className="row gap6" style={{ alignItems: 'center', fontWeight: 600, color: 'var(--text-primary)', flex: 'none' }}>
            <Icon name="git-branch" size={13} style={{ color: 'var(--accent-primary)' }} />
            {t('explain.title')}
          </span>
          {plan && (
            <span style={{ color: 'var(--text-tertiary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {plan.databaseType.toUpperCase()} · {t('explain.nodeCount', { count: nodeCount })}
            </span>
          )}
        </div>
        {plan && (
          <div className="row" style={{ gap: 2, padding: 2, borderRadius: 9, background: 'var(--surface-sunken)', flex: 'none' }}>
            {tabBtn('tree', t('explain.tree'), 'git-branch', 'explain-view-tree')}
            {tabBtn('summary', t('explain.summary'), 'table-2', 'explain-view-summary')}
            {tabBtn('json', 'JSON', 'file-code', 'explain-view-json')}
          </div>
        )}
        {onClose && (
          <button className="icon-btn bare" title={t('explain.close')} onClick={onClose} style={{ flex: 'none' }}>
            <Icon name="x" size={14} />
          </button>
        )}
      </div>

      {/* 主体:loading / error / empty / 三视图 */}
      {loading ? (
        <div className="col" style={{ flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--text-tertiary)' }}>
          <Icon name="loader" size={24} style={{ animation: 'spin 1s linear infinite' }} />
          <span style={{ fontSize: 13 }}>{t('explain.running')}</span>
        </div>
      ) : error ? (
        <div className="col" style={{ flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div className="row gap6" style={{
            maxWidth: 560, alignItems: 'flex-start', padding: '8px 12px', borderRadius: 9, fontSize: 13,
            border: '1px solid var(--danger-border, var(--border-hairline))', background: 'var(--danger-surface, var(--surface-sunken))', color: 'var(--danger-text, var(--text-primary))',
          }}>
            <Icon name="alert-triangle" size={15} style={{ flex: 'none', marginTop: 1 }} />
            <span>{error}</span>
          </div>
        </div>
      ) : !plan ? (
        <div className="col" style={{ flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
          {t('explain.empty')}
        </div>
      ) : view === 'tree' ? (
        <div className="col" style={{ flex: 1, minHeight: 0, overflow: 'auto', gap: 6, padding: 14 }}>
          {plan.nodes.map(node => <TreeNode key={node.id} node={node} depth={0} />)}
        </div>
      ) : view === 'summary' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, textAlign: 'left' }}>
            <thead>
              <tr style={{ color: 'var(--text-tertiary)' }}>
                <th style={{ padding: '5px 8px', fontWeight: 500 }}>{t('explain.node')}</th>
                <th style={{ padding: '5px 8px', fontWeight: 500 }}>{t('explain.relation')}</th>
                <th style={{ padding: '5px 8px', fontWeight: 500 }}>{t('explain.index')}</th>
                <th style={{ padding: '5px 8px', fontWeight: 500 }}>{t('explain.cost')}</th>
                <th style={{ padding: '5px 8px', fontWeight: 500 }}>{t('explain.rows')}</th>
                <th style={{ padding: '5px 8px', fontWeight: 500 }}>{t('explain.details')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ node, depth }) => (
                <tr key={node.id} style={{ borderTop: '1px solid var(--border-hairline)' }}>
                  <td style={{ padding: `5px 8px 5px ${8 + depth * 16}px`, fontWeight: 600, color: 'var(--text-primary)' }}>{node.title}</td>
                  <td style={{ padding: '5px 8px', color: 'var(--text-tertiary)' }}>{node.relation || '-'}</td>
                  <td style={{ padding: '5px 8px', color: 'var(--text-tertiary)' }}>{node.index || '-'}</td>
                  <td style={{ padding: '5px 8px', fontFamily: "'Geist Mono', monospace" }}>{node.cost || '-'}</td>
                  <td style={{ padding: '5px 8px', fontFamily: "'Geist Mono', monospace" }}>{node.rows || '-'}</td>
                  <td style={{ padding: '5px 8px', color: 'var(--text-tertiary)' }}>{node.details.join('; ') || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <pre
          data-testid="explain-json"
          style={{
            flex: 1, minHeight: 0, overflow: 'auto', margin: 12, padding: 12, fontSize: 11.5, lineHeight: 1.5,
            borderRadius: 9, border: '1px solid var(--border-hairline)', background: 'var(--surface-sunken)',
            fontFamily: "'Geist Mono', monospace", color: 'var(--text-primary)',
          }}
        >{rawJson}</pre>
      )}
    </div>
  )
}
