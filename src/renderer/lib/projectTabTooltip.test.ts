import { describe, expect, it } from 'vitest'
import { projectTabTooltip } from './projectTabTooltip'

describe('projectTabTooltip', () => {
  it('names a local project by its folder', () => {
    expect(projectTabTooltip({ name: 'Alpha', cwd: '/repo/alpha' }, 'local')).toBe('/repo/alpha')
  })

  it('says nothing for a canvas with no folder', () => {
    expect(projectTabTooltip({ name: 'Scratch' }, 'local')).toBeNull()
    expect(projectTabTooltip({ name: 'Scratch', cwd: '' }, 'local')).toBeNull()
  })

  it('names the host of an SSH project, since the path is a folder on that machine', () => {
    const ssh = { server: { user: 'root', host: 'box.example' }, remoteCwd: '/srv/app' }
    expect(projectTabTooltip({ name: 'App', ssh }, 'local')).toBe('root@box.example:/srv/app')
  })

  it('names the host of a relay tab of an SSH project', () => {
    const relaySsh = { user: 'enes', host: 'niova', remoteCwd: '/root/nodeterm' }
    expect(projectTabTooltip({ name: 'nt', relaySsh }, 'relay')).toBe('enes@niova:/root/nodeterm')
  })

  it('says why an unavailable tab cannot open, by where it lives', () => {
    expect(projectTabTooltip({ name: 'Alpha', cwd: '/gone', unavailable: true }, 'local')).toBe(
      '/gone is unavailable (folder missing or unreachable)'
    )
    expect(projectTabTooltip({ name: 'Team', unavailable: true }, 'relay')).toBe(
      'Team disconnected, click to reconnect'
    )
  })
})
