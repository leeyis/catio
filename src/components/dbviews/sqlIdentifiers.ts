import {dialectFor} from './sqlDialect'

export interface SqlIdentifier { name: string; quoted: boolean }
/** Alias/CTE identity. Metadata spelling is handled separately: quoting must not
 * silently turn a PostgreSQL or Oracle identifier into a different object. */
export function sqlIdentifierKey(id: SqlIdentifier, engine?: string): string {
  if (dialectFor(engine).spec.caseInsensitiveIdentifiers) return id.name.toLowerCase()
  if (id.quoted) return id.name
  return ['h2', 'oracle', 'oceanbase-oracle'].includes(engine ?? '') ? id.name.toUpperCase() : id.name.toLowerCase()
}
export function sqlIdentifierSearch(id: SqlIdentifier, engine?: string): {key:string; foldStored:boolean} {
  const dialect = dialectFor(engine)
  if (dialect.spec.caseInsensitiveIdentifiers) return {key:id.name.toLowerCase(),foldStored:true}
  if (id.quoted) return {key:id.name,foldStored:false}
  if (['h2', 'oracle', 'oceanbase-oracle'].includes(engine ?? '')) return {key:id.name.toUpperCase(),foldStored:false}
  if (dialect === dialectFor('postgres') && engine !== 'duckdb') return {key:id.name.toLowerCase(),foldStored:false}
  // Unknown JDBC folding and server collations are not known to the editor.
  return {key:id.name.toLowerCase(),foldStored:true}
}
export function sqlIdentifierMatches(id: SqlIdentifier, stored: string, engine?: string): boolean {
  const {key,foldStored}=sqlIdentifierSearch(id,engine)
  return key === (foldStored?stored.toLowerCase():stored)
}
