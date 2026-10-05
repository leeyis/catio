import { render } from '@testing-library/react'
import { afterEach,expect,it } from 'vitest'
import { DatabaseWorkProvider,useReportDatabaseWork,hasPendingDatabaseWork,hasBusyDatabaseDraftWork,listDatabaseDraftWork,removeDatabaseDraftWork } from './databaseDraftWork'
const owner={ownerId:'w:table:a',workbenchId:'w',profileId:'profile-a'}
function Draft({dirty,busy=false}:{dirty:boolean;busy?:boolean}){useReportDatabaseWork('grid',dirty,busy);return null}
afterEach(()=>{for(const item of listDatabaseDraftWork())removeDatabaseDraftWork(item.ownerId,item.kind)})
it('tracks unsaved drafts by exact workspace / profile / owner and removes them on unmount',()=>{const view=render(<DatabaseWorkProvider owner={owner}><Draft dirty/></DatabaseWorkProvider>);expect(hasPendingDatabaseWork({ownerId:owner.ownerId})).toBe(true);expect(hasPendingDatabaseWork({workbenchId:'other'})).toBe(false);expect(hasPendingDatabaseWork({profileId:'other'})).toBe(false);view.unmount();expect(hasPendingDatabaseWork({ownerId:owner.ownerId})).toBe(false)})
it('does not treat a clean mounted pane as pending, but holds an active write',()=>{const view=render(<DatabaseWorkProvider owner={owner}><Draft dirty={false}/></DatabaseWorkProvider>);expect(hasPendingDatabaseWork({workbenchId:'w'})).toBe(false);view.rerender(<DatabaseWorkProvider owner={owner}><Draft dirty={false} busy/></DatabaseWorkProvider>);expect(hasBusyDatabaseDraftWork({workbenchId:'w'})).toBe(true);view.rerender(<DatabaseWorkProvider owner={owner}><Draft dirty={false}/></DatabaseWorkProvider>);expect(hasBusyDatabaseDraftWork()).toBe(false)})
it('keeps a standalone component outside the database workbench isolated',()=>{render(<Draft dirty busy/>);expect(listDatabaseDraftWork()).toHaveLength(0)})
