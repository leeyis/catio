import { render,screen,fireEvent } from '@testing-library/react'
import { expect,it,vi } from 'vitest'
import { MetadataNodeActions, type MetadataAction } from './MetadataNodeActions'
const item=(action:()=>void,disabled=false):MetadataAction=>({id:'edit',label:'Edit',icon:'pencil',action,disabled})
it('opens the same portal model with the keyboard and returns focus on Escape',()=>{
  const action=vi.fn();render(<MetadataNodeActions title="Actions" ownerKey="c/a" items={[item(action)]}><button>Node</button></MetadataNodeActions>)
  fireEvent.keyDown(screen.getByText('Node'),{key:'F10',shiftKey:true});expect(screen.getByRole('menuitem',{name:'Edit'})).toHaveFocus();fireEvent.keyDown(screen.getByRole('menu'),{key:'Escape'});expect(screen.queryByRole('menu')).toBeNull();expect(screen.getByRole('button',{name:'Actions'})).toHaveFocus()
})
it('invalidates a pending menu when its owner changes',()=>{
  const old=vi.fn(),next=vi.fn();const {rerender}=render(<MetadataNodeActions title="Actions" ownerKey="c1" items={[item(old)]}><button>Node</button></MetadataNodeActions>);fireEvent.contextMenu(screen.getByText('Node'));expect(screen.getByRole('menu')).toBeInTheDocument();rerender(<MetadataNodeActions title="Actions" ownerKey="c2" items={[item(next)]}><button>Node</button></MetadataNodeActions>);expect(screen.queryByRole('menu')).toBeNull();expect(old).not.toHaveBeenCalled();expect(next).not.toHaveBeenCalled()
})
it('closes a stale action when it becomes disabled',()=>{
  const action=vi.fn();const {rerender}=render(<MetadataNodeActions title="Actions" ownerKey="c" items={[item(action)]}><button>Node</button></MetadataNodeActions>);fireEvent.click(screen.getByRole('button',{name:'Actions'}));rerender(<MetadataNodeActions title="Actions" ownerKey="c" items={[item(action,true)]}><button>Node</button></MetadataNodeActions>);expect(screen.queryByRole('menu')).toBeNull();expect(action).not.toHaveBeenCalled()
})
