/**
 * 跨库/跨表数据迁移的前端纯逻辑：可选模式、原生 upsert 支持判定、就绪校验。
 *
 * 对齐 dbx components/transfer/DataTransferDialog.vue 的「模式选择 + 列映射 + upsert 键」
 * 交互约束。列名自动映射复用 tableImport.ts 的 autoMapImportColumns（源列名→目标列名同构）。
 * 真实迁移与写 SQL 生成在 Rust 后端（transfer.rs，已单测），这里只做对话框的可测约束。
 */

import type { TransferMode } from '../../services/db'

/** 支持原生 upsert 的引擎（与后端 transfer::supports_native_upsert 一致）。 */
const NATIVE_UPSERT_ENGINES = new Set(['postgres', 'mysql', 'sqlite', 'duckdb', 'sqlserver'])

/**
 * 目标引擎是否支持原生 upsert。大小写不敏感;未知/缺省引擎按「不支持」处理——
 * 避免暴露一个在后端会静默退化为普通 INSERT 的 upsert 选项。
 */
export function engineSupportsNativeUpsert(engine?: string): boolean {
  if (!engine) return false
  return NATIVE_UPSERT_ENGINES.has(engine.toLowerCase())
}

/**
 * 目标引擎可用的迁移模式：append/overwrite 总是可用；upsert 仅当目标支持原生 upsert。
 */
export function availableTransferModes(targetEngine?: string): TransferMode[] {
  const modes: TransferMode[] = ['append', 'overwrite']
  if (engineSupportsNativeUpsert(targetEngine)) modes.push('upsert')
  return modes
}

/** source → target 列映射对象里，已实际映射（目标非空）的目标列集合。 */
function mappedTargets(mapping: Record<string, string>): Set<string> {
  return new Set(Object.values(mapping).map((t) => t.trim()).filter((t) => t !== ''))
}

/**
 * 迁移是否就绪（决定「开始迁移」按钮可点）：
 * - 必须有目标表名；
 * - 至少有一个已映射的列；
 * - upsert 模式：至少一个键,且每个键都落在已映射的目标列里。
 */
export function transferReady(args: {
  targetTable: string
  mapping: Record<string, string>
  mode: TransferMode
  upsertKeys: string[]
}): boolean {
  if (!args.targetTable.trim()) return false
  const targets = mappedTargets(args.mapping)
  if (targets.size === 0) return false
  if (args.mode === 'upsert') {
    if (args.upsertKeys.length === 0) return false
    if (!args.upsertKeys.every((k) => targets.has(k))) return false
  }
  return true
}
