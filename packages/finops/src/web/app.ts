import { buildFinopsDashboardData } from '../dashboard-model.js'
import { demoWorkspaceInput } from '../demo-data.js'
import type {
  AccountingSummary,
  ApiKeyReference,
  ProductDashboardSummary,
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

let selectedProductId = dashboard.products[0]?.productId ?? ''
let selectedRepo = ''
let selectedEnvVar = ''

root.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const actionTarget = target.closest<HTMLElement>('[data-action]')
  if (!actionTarget) return

  const action = actionTarget.dataset.action
  if (action === 'select-product') {
    selectedProductId = actionTarget.dataset.productId ?? selectedProductId
    selectedRepo = ''
    selectedEnvVar = ''
    render()
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
  const product = selectedProduct()
  const repo = selectedRepository(product)
  const credential = selectedCredential(repo?.references ?? [])
  const companySummary = dashboard.companySummary[0] ?? emptySummary()
  const selectedProviders = new Set(product.providerSpend.map((item) => item.provider))
  const pricingRows = dashboard.pricing.entries
    .filter((entry) => selectedProviders.has(entry.provider))
    .slice(0, 16)

  root.innerHTML = `
    <header class="topbar">
      <div>
        <p class="eyebrow">wanman FinOps</p>
        <h1>${escapeHtml(dashboard.company.name ?? dashboard.company.id)}</h1>
      </div>
      <div class="status-pill">Demo inventory: ${dashboard.inventory.references.length} credential refs, no key values</div>
    </header>
    <main class="shell">
      <section class="metric-grid" aria-label="Company summary">
        ${metricCard('Revenue', formatMoney(companySummary.revenue, companySummary.currency), 'Stripe ledger')}
        ${metricCard('Cost', formatMoney(companySummary.cost, companySummary.currency), 'Provider spend')}
        ${metricCard('Gross profit', formatMoney(companySummary.grossProfit, companySummary.currency), companySummary.breakEven ? 'Break-even met' : 'Below break-even')}
        ${metricCard('ROI', formatRoi(companySummary.roi), 'Gross profit / cost')}
        ${metricCard('Products', String(dashboard.products.length), 'Mapped dashboards')}
        ${metricCard('Credentials', String(dashboard.inventory.references.length), 'Inventory references')}
      </section>

      <section class="main-grid">
        <article class="panel product-panel">
          <div class="panel-heading">
            <h2>Product Dashboards</h2>
            <span>${dashboard.generatedAt.slice(0, 10)}</span>
          </div>
          <div class="product-list">
            ${dashboard.products.map(productRow).join('')}
          </div>
        </article>

        <article class="panel drilldown-panel">
          <div class="panel-heading">
            <h2>${escapeHtml(product.name)}</h2>
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
      </section>

      <section class="wide-grid">
        <article class="panel">
          <div class="panel-heading">
            <h2>Provider Spend</h2>
            <span>${dashboard.providerSpend.length} providers</span>
          </div>
          ${providerSpendList(dashboard.providerSpend)}
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
    </main>
  `
}

function selectedProduct(): ProductDashboardSummary {
  return dashboard.products.find((product) => product.productId === selectedProductId) ?? dashboard.products[0] ?? {
    productId: 'empty',
    name: 'No products',
    summary: emptySummary(),
    providerSpend: [],
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

function productRow(product: ProductDashboardSummary): string {
  const active = product.productId === selectedProductId ? ' is-active' : ''
  return `
    <button class="product-row${active}" data-action="select-product" data-product-id="${escapeAttr(product.productId)}">
      <span>
        <strong>${escapeHtml(product.name)}</strong>
        <small>${product.repositories.length} repos · ${product.repositories.reduce((sum, repo) => sum + repo.references.length, 0)} refs</small>
      </span>
      <span class="row-metrics">
        <b>${formatMoney(product.summary.grossProfit, product.summary.currency)}</b>
        <small>${formatRoi(product.summary.roi)}</small>
      </span>
    </button>
  `
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
          <div class="bar"><span style="width: ${Math.max(4, Math.round((row.cost / max) * 100))}%"></span></div>
        </div>
      `).join('')}
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

function emptySummary(): AccountingSummary {
  return {
    companyId: dashboard.company.id,
    productId: selectedProductId,
    currency: dashboard.company.baseCurrency ?? 'USD',
    revenue: 0,
    cost: 0,
    grossProfit: 0,
    roi: null,
    breakEven: true,
  }
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
