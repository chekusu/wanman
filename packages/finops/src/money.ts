const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'ugx',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
])

export function normalizeCurrency(currency: string): string {
  return currency.trim().toLowerCase()
}

export function minorUnitFactor(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(normalizeCurrency(currency)) ? 1 : 100
}

export function fromMinorUnits(amount: number, currency: string): number {
  return amount / minorUnitFactor(currency)
}

export function roundMoney(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 10000) / 10000
}
