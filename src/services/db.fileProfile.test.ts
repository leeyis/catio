import { describe, expect, it } from 'vitest'
import { dbConnectArgsFromProfile } from './db'
import { dbProfileToConnection } from '../state/dbConnections'

describe('native file profile reconnect', () => {
  it.each(['sqlite','duckdb'] as const)('drops stale network and credential fields for %s', dbType => {
    const profile = {id:'file-db',name:'local',dbType,host:'I:/data/中文.db',port:5432,user:'old',database:'old',options:'a=1',driverProfile:'old',ssl:true,sslMode:'require',caCertPath:'old.pem',sslRejectUnauthorized:false}
    expect(dbConnectArgsFromProfile(profile,'unused-test-token')).toEqual({dbType,host:profile.host,port:0,user:''})
    expect(dbProfileToConnection(profile).sub).toBe(`${dbType} · ${profile.host}`)
  })
  it('does not treat a JDBC profile label as an unauthenticated native file connection', () => {
    expect(dbConnectArgsFromProfile({dbType:'jdbc',driverProfile:'sqlite',host:'jdbc:sqlite:x',port:0,user:'u'},'test-token').secret).toBe('test-token')
  })
})
