import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {expect,it} from 'vitest'

it('explicitly enables the desktop target when Tauri invokes cargo with no default features',()=>{
  const config=JSON.parse(readFileSync(resolve('src-tauri/tauri.conf.json'),'utf8'))
  expect(config.build.features).toContain('desktop')
  const cargo=readFileSync(resolve('src-tauri/Cargo.toml'),'utf8')
  expect(cargo).toMatch(/default\s*=\s*\["desktop"\]/)
  const target=cargo.split('[[bin]]').slice(1).find(block=>/^\s*name\s*=\s*"catio"/m.test(block))!
  expect(target).toMatch(/required-features\s*=\s*\["desktop"\]/)
})
