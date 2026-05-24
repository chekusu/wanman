export interface ChartDimensions {
  width: number
  height: number
  padding: number
}

export function chartDomain(values: number[]): { min: number, max: number } {
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  if (min === max) return { min: min - 1, max: max + 1 }
  return { min, max }
}

export function buildLineChartPath(
  values: number[],
  dimensions: ChartDimensions,
  domain = chartDomain(values),
): string {
  if (!values.length) return ''

  const innerWidth = dimensions.width - dimensions.padding * 2
  const innerHeight = dimensions.height - dimensions.padding * 2
  const range = domain.max - domain.min || 1
  const step = values.length === 1 ? 0 : innerWidth / (values.length - 1)
  const commands = values.map((value, index) => {
    const x = dimensions.padding + step * index
    const y = dimensions.padding + (1 - ((value - domain.min) / range)) * innerHeight
    return `${index === 0 ? 'M' : 'L'} ${roundChartValue(x)} ${roundChartValue(y)}`
  })

  return commands.join(' ')
}

export function barWidthPercent(value: number, maxValue: number, minimum = 4): number {
  if (value <= 0 || maxValue <= 0) return 0
  return Math.max(minimum, Math.round((value / maxValue) * 100))
}

function roundChartValue(value: number): number {
  return Math.round(value * 100) / 100
}
