export type FinopsRoute =
  | { view: 'home' }
  | { view: 'project', productId: string }

export function parseFinopsRoute(hash: string): FinopsRoute {
  const raw = hash.replace(/^#/, '') || '/'
  const normalized = raw.startsWith('/') ? raw : `/${raw}`
  const path = normalized.split('?')[0] ?? '/'
  const segments = path.split('/').filter(Boolean)

  if (segments[0] === 'projects' && segments[1]) {
    return { view: 'project', productId: decodeURIComponent(segments[1]) }
  }

  return { view: 'home' }
}

export function routeToHash(route: FinopsRoute): string {
  if (route.view === 'home') return '#/'
  return `#/projects/${encodeURIComponent(route.productId)}`
}
