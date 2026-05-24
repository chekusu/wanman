import { buildFinopsDashboardData } from '../dashboard-model.js'
import { demoWorkspaceInput } from '../demo-data.js'
import { barWidthPercent, buildLineChartPath, chartDomain } from './charts.js'
import { parseFinopsRoute, routeToHash, type FinopsRoute } from './routing.js'
import type {
  AccountingSummary,
  ApiKeyReference,
  ProductDashboardSummary,
  ProfitabilityTrendPoint,
  ProviderCategorySpendSummary,
  ProviderPricingEntry,
  ProviderSpendSummary,
  SourceLedgerRow,
} from '../types.js'

const dashboard = buildFinopsDashboardData(demoWorkspaceInput)
const appRoot = document.querySelector<HTMLDivElement>('#app')

if (!appRoot) {
  throw new Error('Missing #app root')
}
const root: HTMLDivElement = appRoot

let route: FinopsRoute = normalizeRoute(parseFinopsRoute(window.location.hash))
let selectedRepo = ''
let selectedEnvVar = ''

window.addEventListener('hashchange', () => {
  route = normalizeRoute(parseFinopsRoute(window.location.hash))
  selectedRepo = ''
  selectedEnvVar = ''
  render()
})

root.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const actionTarget = target.closest<HTMLElement>('[data-action]')
  if (!actionTarget) return

  const action = actionTarget.dataset.action
  if (action === 'navigate-home') {
    navigate({ view: 'home' })
  }
  if (action === 'select-product') {
    navigate({ view: 'project', productId: actionTarget.dataset.productId ?? firstProductId() })
  }
  if (action === 'select-repo') {
    selectedRepo = actionTarget.dataset.repo ?? selectedRepo
    selectedEnvVar = ''
    render()
  }
  if (action === 'select-env') {
    selectedEnvVar = actionTarget.dataset.envVar ?? selectedEnvVar
    render()
  }
})

render()

function render(): void {
  const summary = dashboard.companySummary[0] ?? emptySummary()
  const product = selectedProduct()

  root.innerHTML = `
    <header class="topbar">
      <div class="brand-block">
        <p class="eyebrow">wanman FinOps</p>
        <h1>${escapeHtml(dashboard.company.name ?? dashboard.company.id)}</h1>
      </div>
      <div class="status-pill">Sanitized demo data · ${dashboard.inventory.references.length} credential refs · no key values</div>
    </header>
    <nav class="view-nav" aria-label="FinOps views">
      <button class="nav-item${route.view === 'home' ? ' is-active' : ''}" data-action="navigate-home">Dashboard</button>
      ${dashboard.products.map((item) => `
        <button class="nav-item${route.view === 'project' && item.productId === product.productId ? ' is-active' : ''}" data-action="select-product" data-product-id="${escapeAttr(item.productId)}">
          ${escapeHtml(item.name)}
        </button>
      `).join('')}
    </nav>
    <main class="shell">
      ${route.view === 'home' ? homeView(summary) : projectView(product)}
    </main>
  `
}

function homeView(summary: AccountingSummary): string {
  return `
    <section class="metric-grid" aria-label="Company summary">
      ${metricCard('Revenue', formatMoney(summary.revenue, summary.currency), 'Stripe demo ledger')}
      ${metricCard('Cost', formatMoney(summary.cost, summary.currency), 'Provider spend')}
      ${metricCard('Gross profit', formatMoney(summary.grossProfit, summary.currency), summary.breakEven ? 'Break-even met' : 'Below break-even')}
      ${metricCard('ROI', formatRoi(summary.roi), 'Gross profit / cost')}
      ${metricCard('Products', String(dashboard.products.length), 'Mapped projects')}
      ${metricCard('Credentials', String(dashboard.inventory.references.length), 'Inventory refs')}
    </section>

    <section class="dashboard-grid">
      <article class="panel trend-panel">
        <div class="panel-heading">
          <h2>Profitability Trend</h2>
          <span>${trendRange(dashboard.profitabilityTrend)}</span>
        </div>
        ${profitabilityChart(dashboard.profitabilityTrend, summary.currency)}
      </article>

      <article class="panel">
        <div class="panel-heading">
          <h2>Project Portfolio</h2>
          <span>${dashboard.products.length} projects</span>
        </div>
        <div class="portfolio-list">
          ${dashboard.products.map(portfolioRow).join('')}
        </div>
      </article>
    </section>

    <section class="wide-grid">
      <article class="panel">
        <div class="panel-heading">
          <h2>Provider Categories</h2>
          <span>${dashboard.providerCategorySpend.length} categories</span>
        </div>
        ${providerCategoryBars(dashboard.providerCategorySpend)}
      </article>

      <article class="panel">
        <div class="panel-heading">
          <h2>Provider Spend</h2>
          <span>${dashboard.providerSpend.length} providers</span>
        </div>
        ${providerSpendList(dashboard.providerSpend)}
      </article>
    </section>
  `
}

function projectView(product: ProductDashboardSummary): string {
  const repo = selectedRepository(product)
  const credential = selectedCredential(repo?.references ?? [])
  const selectedProviders = new Set(product.providerSpend.map((item) => item.provider))
  const pricingRows = dashboard.pricing.entries
    .filter((entry) => selectedProviders.has(entry.provider))
    .slice(0, 16)

  return `
    <section class="project-heading">
      <div>
        <p class="eyebrow">Project View</p>
        <h2>${escapeHtml(product.name)}</h2>
        <p>${escapeHtml(product.description ?? 'Sanitized FinOps project')}</p>
      </div>
      <div class="meta-pills">
        ${metadataPill('Owner', product.owner ?? 'Demo')}
        ${metadataPill('Lifecycle', product.lifecycle ?? 'Demo')}
        ${metadataPill('Repos', String(product.repositories.length))}
      </div>
    </section>

    <section class="metric-grid" aria-label="Project summary">
      ${metricCard('Revenue', formatMoney(product.summary.revenue, product.summary.currency), 'Demo Stripe ledger')}
      ${metricCard('Cost', formatMoney(product.summary.cost, product.summary.currency), 'Mapped providers')}
      ${metricCard('Gross profit', formatMoney(product.summary.grossProfit, product.summary.currency), product.summary.breakEven ? 'Break-even met' : 'Below break-even')}
      ${metricCard('ROI', formatRoi(product.summary.roi), 'Gross profit / cost')}
      ${metricCard('Cost categories', String(product.providerCategorySpend.length), 'Provider breakdown')}
      ${metricCard('Credentials', String(product.repositories.reduce((sum, item) => sum + item.references.length, 0)), 'Inventory refs')}
    </section>

    <section class="dashboard-grid">
      <article class="panel trend-panel">
        <div class="panel-heading">
          <h2>Profitability Trend</h2>
          <span>${trendRange(product.profitabilityTrend)}</span>
        </div>
        ${profitabilityChart(product.profitabilityTrend, product.summary.currency)}
      </article>

      <article class="panel">
        <div class="panel-heading">
          <h2>Cost Categories</h2>
          <span>${product.providerCategorySpend.length} categories</span>
        </div>
        ${providerCategoryBars(product.providerCategorySpend)}
      </article>
    </section>

    <section class="main-grid">
      <article class="panel drilldown-panel">
        <div class="panel-heading">
          <h2>Credential Inventory</h2>
          <span>${product.repositories.length} repos</span>
        </div>
        <div class="split">
          <div class="stack">
            <h3>Repos</h3>
            <div class="button-stack">
              ${product.repositories.map((item) => repoButton(item.repo)).join('') || emptyState('No inventory')}
            </div>
          </div>
          <div class="stack">
            <h3>Env Vars</h3>
            <div class="button-stack">
              ${(repo?.references ?? []).map(envButton).join('') || emptyState('No credential refs')}
            </div>
          </div>
        </div>
        ${credentialDetails(credential)}
      </article>

      <article class="panel">
        <div class="panel-heading">
          <h2>Source Ledgers</h2>
          <span>${escapeHtml(product.name)}</span>
        </div>
        ${ledgerTable(dashboard.ledgerRows.filter((row) => row.productId === product.productId))}
      </article>
    </section>

    <section class="panel">
      <div class="panel-heading">
        <h2>Provider Pricing Registry</h2>
        <span>${dashboard.pricing.sources.filter((source) => source.ok).length}/${dashboard.pricing.sources.length} sources healthy</span>
      </div>
      ${pricingTable(pricingRows.length ? pricingRows : dashboard.pricing.entries.slice(0, 16))}
    </section>
  `
}

function profitabilityChart(points: ProfitabilityTrendPoint[], currency: string): string {
  if (!points.length) return emptyState('No trend data')

  const dimensions = { width: 640, height: 220, padding: 28 }
  const values = points.flatMap((point) => [point.revenue, point.cost, point.grossProfit])
  const domain = chartDomain(values)
  const revenuePath = buildLineChartPath(points.map((point) => point.revenue), dimensions, domain)
  const costPath = buildLineChartPath(points.map((point) => point.cost), dimensions, domain)
  const profitPath = buildLineChartPath(points.map((point) => point.grossProfit), dimensions, domain)
  const zeroY = zeroLineY(domain, dimensions)
  const latest = points.at(-1)

  return `
    <div class="chart-wrap">
      <svg class="trend-chart" viewBox="0 0 ${dimensions.width} ${dimensions.height}" role="img" aria-label="Revenue cost and gross profit trend">
        <line x1="${dimensions.padding}" y1="${zeroY}" x2="${dimensions.width - dimensions.padding}" y2="${zeroY}" class="zero-line" />
        <path d="${revenuePath}" class="chart-line revenue-line" />
        <path d="${costPath}" class="chart-line cost-line" />
        <path d="${profitPath}" class="chart-line profit-line" />
      </svg>
      <div class="chart-legend">
        ${legendItem('Revenue', 'revenue')}
        ${legendItem('Cost', 'cost')}
        ${legendItem('Gross profit', 'profit')}
        <span>${latest ? `${formatPeriod(latest.period)} ${formatMoney(latest.grossProfit, latest.currency || currency)}` : ''}</span>
      </div>
      <div class="period-row">
        ${points.map((point) => `<span>${escapeHtml(formatPeriod(point.period))}</span>`).join('')}
      </div>
      <div class="break-even-row">
        ${points.map((point) => `<span class="${point.breakEven ? 'is-ok' : 'is-risk'}">${point.breakEven ? 'BE' : 'Risk'}</span>`).join('')}
      </div>
    </div>
  `
}

function zeroLineY(domain: { min: number, max: number }, dimensions: { height: number, padding: number }): number {
  const innerHeight = dimensions.height - dimensions.padding * 2
  const range = domain.max - domain.min || 1
  const y = dimensions.padding + (1 - ((0 - domain.min) / range)) * innerHeight
  return Math.round(y * 100) / 100
}

function portfolioRow(product: ProductDashboardSummary): string {
  const latest = product.profitabilityTrend.at(-1)
  return `
    <button class="portfolio-row" data-action="select-product" data-product-id="${escapeAttr(product.productId)}">
      <span>
        <strong>${escapeHtml(product.name)}</strong>
        <small>${escapeHtml(product.owner ?? 'Demo')} · ${escapeHtml(product.lifecycle ?? 'Demo')}</small>
      </span>
      <span class="row-metrics">
        <b>${formatMoney(product.summary.grossProfit, product.summary.currency)}</b>
        <small>${latest ? `${formatPeriod(latest.period)} ${formatRoi(latest.roi)}` : formatRoi(product.summary.roi)}</small>
      </span>
    </button>
  `
}

function providerSpendList(rows: ProviderSpendSummary[]): string {
  if (!rows.length) return emptyState('No provider costs')
  const max = Math.max(...rows.map((row) => row.cost), 1)
  return `
    <div class="spend-list">
      ${rows.map((row) => `
        <div class="spend-row">
          <div>
            <strong>${escapeHtml(row.provider)}</strong>
            <span>${formatMoney(row.cost, row.currency)}</span>
          </div>
          <div class="bar"><span style="width: ${barWidthPercent(row.cost, max)}%"></span></div>
        </div>
      `).join('')}
    </div>
  `
}

function providerCategoryBars(rows: ProviderCategorySpendSummary[]): string {
  if (!rows.length) return emptyState('No provider categories')
  const max = Math.max(...rows.map((row) => row.cost), 1)
  return `
    <div class="category-list">
      ${rows.map((row) => `
        <div class="category-row">
          <div>
            <strong>${escapeHtml(row.provider)}</strong>
            <small>${escapeHtml(row.category)}</small>
          </div>
          <div class="category-meter">
            <span style="width: ${barWidthPercent(row.cost, max)}%"></span>
          </div>
          <b>${formatMoney(row.cost, row.currency)}</b>
        </div>
      `).join('')}
    </div>
  `
}

function selectedProduct(): ProductDashboardSummary {
  const currentRoute = route
  if (currentRoute.view === 'project') {
    const found = dashboard.products.find((product) => product.productId === currentRoute.productId)
    if (found) return found
  }

  return dashboard.products[0] ?? {
    productId: 'empty',
    name: 'No products',
    summary: emptySummary(),
    profitabilityTrend: [],
    providerSpend: [],
    providerCategorySpend: [],
    repositories: [],
    costs: [],
    revenue: [],
    usage: [],
  }
}

function selectedRepository(product: ProductDashboardSummary): ProductDashboardSummary['repositories'][number] | undefined {
  const repo = product.repositories.find((item) => item.repo === selectedRepo) ?? product.repositories[0]
  selectedRepo = repo?.repo ?? ''
  return repo
}

function selectedCredential(references: ApiKeyReference[]): ApiKeyReference | undefined {
  const credential = references.find((item) => item.envVar === selectedEnvVar) ?? references[0]
  selectedEnvVar = credential?.envVar ?? ''
  return credential
}

function normalizeRoute(next: FinopsRoute): FinopsRoute {
  if (next.view === 'project' && dashboard.products.some((product) => product.productId === next.productId)) {
    return next
  }
  return { view: 'home' }
}

function navigate(next: FinopsRoute): void {
  const normalized = normalizeRoute(next)
  const hash = routeToHash(normalized)
  if (window.location.hash === hash) {
    route = normalized
    selectedRepo = ''
    selectedEnvVar = ''
    render()
    return
  }
  window.location.hash = hash
}

function firstProductId(): string {
  return dashboard.products[0]?.productId ?? ''
}

function repoButton(repo: string): string {
  const active = repo === selectedRepo ? ' is-active' : ''
  return `<button class="selector${active}" data-action="select-repo" data-repo="${escapeAttr(repo)}">${escapeHtml(repo)}</button>`
}

function envButton(ref: ApiKeyReference): string {
  const active = ref.envVar === selectedEnvVar ? ' is-active' : ''
  return `
    <button class="selector${active}" data-action="select-env" data-env-var="${escapeAttr(ref.envVar)}">
      <span>${escapeHtml(ref.envVar)}</span>
      <small>${escapeHtml(ref.provider)}</small>
    </button>
  `
}

function credentialDetails(ref: ApiKeyReference | undefined): string {
  if (!ref) return `<div class="details">${emptyState('No credential selected')}</div>`
  return `
    <div class="details">
      <div class="details-grid">
        <div>
          <span class="label">Env var</span>
          <strong>${escapeHtml(ref.envVar)}</strong>
        </div>
        <div>
          <span class="label">Name provider</span>
          <strong>${escapeHtml(ref.credentialProvider)}</strong>
        </div>
        <div>
          <span class="label">Billing/source provider</span>
          <strong>${escapeHtml(ref.provider)}</strong>
        </div>
        <div>
          <span class="label">Secret values</span>
          <strong>Not collected</strong>
        </div>
      </div>
      <h3>Evidence</h3>
      <div class="evidence-list">
        ${ref.providerEvidence.map((item) => `
          <div class="evidence-row">
            <span>${escapeHtml(item.kind)}</span>
            <code>${escapeHtml(item.value)}</code>
            <small>${escapeHtml(item.sourceFile)}</small>
          </div>
        `).join('')}
      </div>
    </div>
  `
}

function ledgerTable(rows: SourceLedgerRow[]): string {
  if (!rows.length) return emptyState('No ledger rows')
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Period</th>
            <th>Kind</th>
            <th>Provider</th>
            <th>Metric</th>
            <th>Amount</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>${escapeHtml(row.period)}</td>
              <td>${escapeHtml(row.kind)}</td>
              <td>${escapeHtml(row.provider)}</td>
              <td>${escapeHtml(row.metric ?? '-')}</td>
              <td>${row.amount === undefined ? formatQuantity(row) : formatMoney(row.amount, row.currency ?? 'USD')}</td>
              <td>${escapeHtml(row.source)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `
}

function pricingTable(rows: ProviderPricingEntry[]): string {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>SKU</th>
            <th>Metric</th>
            <th>Price</th>
            <th>Method</th>
            <th>Cadence</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>${escapeHtml(row.provider)}</td>
              <td>${escapeHtml(row.sku)}</td>
              <td>${escapeHtml(row.metric)}</td>
              <td>${formatUnitPrice(row)}</td>
              <td>${escapeHtml(row.pricingMethod)}</td>
              <td>${escapeHtml(row.updateCadence)}</td>
              <td><a href="${escapeAttr(row.sourceUrl)}" target="_blank" rel="noreferrer">source</a></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `
}

function metricCard(label: string, value: string, helper: string): string {
  return `
    <article class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(helper)}</small>
    </article>
  `
}

function metadataPill(label: string, value: string): string {
  return `
    <span class="meta-pill">
      <small>${escapeHtml(label)}</small>
      <strong>${escapeHtml(value)}</strong>
    </span>
  `
}

function legendItem(label: string, tone: 'revenue' | 'cost' | 'profit'): string {
  return `<span class="legend-item ${tone}"><i></i>${escapeHtml(label)}</span>`
}

function trendRange(points: ProfitabilityTrendPoint[]): string {
  if (!points.length) return 'No trend'
  const first = points[0]!
  const last = points.at(-1) ?? first
  return `${formatPeriod(first.period)} to ${formatPeriod(last.period)}`
}

function emptySummary(productId = selectedProductId()): AccountingSummary {
  return {
    companyId: dashboard.company.id,
    productId,
    currency: dashboard.company.baseCurrency ?? 'USD',
    revenue: 0,
    cost: 0,
    grossProfit: 0,
    roi: null,
    breakEven: true,
  }
}

function selectedProductId(): string {
  return route.view === 'project' ? route.productId : firstProductId()
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    maximumFractionDigits: currency.toUpperCase() === 'JPY' ? 0 : 2,
  }).format(amount)
}

function formatRoi(value: number | null): string {
  if (value === null) return 'n/a'
  return `${Math.round(value * 100)}%`
}

function formatQuantity(row: SourceLedgerRow): string {
  if (row.quantity === undefined) return '-'
  return `${new Intl.NumberFormat('en-US').format(row.quantity)} ${row.unit ?? ''}`.trim()
}

function formatUnitPrice(row: ProviderPricingEntry): string {
  const value = row.unit === 'token'
    ? `$${row.unitPrice.toFixed(9)}`
    : formatMoney(row.unitPrice, row.currency)
  return `${value} / ${escapeHtml(row.unit)}`
}

function formatPeriod(period: string): string {
  const date = new Date(`${period}-01T00:00:00.000Z`)
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(date)
}

function emptyState(label: string): string {
  return `<div class="empty">${escapeHtml(label)}</div>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttr(value: string): string {
  return escapeHtml(value)
}
