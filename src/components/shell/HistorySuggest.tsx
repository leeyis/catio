/**
 * HistorySuggest — 终端历史补全的下拉候选列表(纯展示组件)。
 *
 * 不持有任何 xterm / 业务状态:候选、选中项、坐标、当前输入全部由 TerminalPane
 * 通过 props 传入,交互(点选)通过 onPick 回调上抛。样式复用 TerminalPane 里
 * Multi-Exec 弹窗的下拉风格(pop-in + surface-elevated + shadow-dropdown),
 * 全部走 CSS 变量,跟随主题。
 */
import { useTranslation } from 'react-i18next'
import type { HistoryMatch } from './historyCompletion'

export interface HistorySuggestProps {
  /** 候选列表(已排序、去重、截断)。 */
  items: HistoryMatch[]
  /** 当前高亮项的下标。 */
  selectedIndex: number
  /** 绝对定位坐标(相对于 TerminalPane 根容器)。 */
  left: number
  top: number
  /** 当 true 时锚点在 top 处向「上」展开(光标下方空间不足时翻转)。 */
  flipUp?: boolean
  /** 当前输入,用于把匹配到的前缀加粗高亮。 */
  input: string
  /** 点选某一项(传入其下标)。 */
  onPick: (index: number) => void
}

export function HistorySuggest({ items, selectedIndex, left, top, flipUp, input, onPick }: HistorySuggestProps) {
  const { t } = useTranslation()
  if (!items.length) return null

  return (
    <div
      className="pop-in col"
      style={{
        position: 'absolute',
        left,
        top,
        transform: flipUp ? 'translateY(-100%)' : undefined,
        zIndex: 28,
        minWidth: 220,
        maxWidth: 420,
        maxHeight: 260,
        background: 'var(--surface-elevated)',
        border: '1px solid var(--border-hairline-alt)',
        borderRadius: 10,
        boxShadow: 'var(--shadow-dropdown)',
        padding: 4,
      }}
    >
      {/* 候选列表:仅此区域滚动,说明行固定在底部始终可见(否则候选多时说明被挤出滚动区)。 */}
      <div className="col" style={{ minHeight: 0, overflowY: 'auto' }}>
      {items.map((m, i) => {
        const on = i === selectedIndex
        // 严格大小写前缀命中时把前缀部分加粗;否则整体常规渲染。
        const hasPrefix = m.text.startsWith(input)
        return (
          <button
            key={`${m.text}-${i}`}
            // mousedown.preventDefault 避免点击候选时终端失焦
            onMouseDown={e => e.preventDefault()}
            onClick={() => onPick(i)}
            className="row mono"
            title={m.text}
            style={{
              textAlign: 'left',
              gap: 0,
              width: '100%',
              padding: '5px 9px',
              borderRadius: 7,
              fontSize: 12.5,
              lineHeight: 1.5,
              color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
              background: on ? 'var(--accent-soft)' : 'transparent',
            }}
          >
            {/* 单行文本容器:min-width:0 + overflow 才能让 text-overflow 在 flex 项内生效,
                超长命令右侧收敛为省略号(完整文本仍在 title 里)。 */}
            <span
              style={{
                minWidth: 0,
                flex: 1,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {hasPrefix ? (
                <>
                  <span style={{ fontWeight: 700, color: 'var(--accent-primary)' }}>{input}</span>
                  {m.text.slice(input.length)}
                </>
              ) : (
                m.text
              )}
            </span>
          </button>
        )
      })}
      </div>
      <div style={{ padding: '4px 9px 2px', fontSize: 10, color: 'var(--text-faint)', whiteSpace: 'nowrap', flex: 'none' }}>
        {t('workbench.historySuggestHint')}
      </div>
    </div>
  )
}
