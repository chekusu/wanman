import { describe, expect, it } from 'vitest'
import { parseFinopsRoute, routeToHash } from '../web/routing.js'

describe('FinOps web routing helpers', () => {
  it('parses the macro dashboard route', () => {
    expect(parseFinopsRoute('')).toEqual({ view: 'home' })
    expect(parseFinopsRoute('#/')).toEqual({ view: 'home' })
  })

  it('parses and formats project detail routes', () => {
    expect(parseFinopsRoute('#/projects/wanman-cloud')).toEqual({ view: 'project', productId: 'wanman-cloud' })
    expect(routeToHash({ view: 'project', productId: 'sandbank-cloud' })).toBe('#/projects/sandbank-cloud')
  })

  it('decodes project identifiers from hash routes', () => {
    expect(parseFinopsRoute('#/projects/project%20with%20spaces')).toEqual({
      view: 'project',
      productId: 'project with spaces',
    })
  })
})
