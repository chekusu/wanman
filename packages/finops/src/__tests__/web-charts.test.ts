import { describe, expect, it } from 'vitest'
import { barWidthPercent, buildLineChartPath, chartDomain } from '../web/charts.js'

describe('FinOps web chart helpers', () => {
  it('keeps zero in the chart domain', () => {
    expect(chartDomain([12, 25, 7])).toEqual({ min: 0, max: 25 })
    expect(chartDomain([-4, 6])).toEqual({ min: -4, max: 6 })
  })

  it('builds stable SVG line paths for trend values', () => {
    const path = buildLineChartPath([0, 50, 100], { width: 120, height: 80, padding: 10 }, { min: 0, max: 100 })

    expect(path).toBe('M 10 70 L 60 40 L 110 10')
  })

  it('returns proportional bar widths with a visible minimum', () => {
    expect(barWidthPercent(0, 100)).toBe(0)
    expect(barWidthPercent(2, 100)).toBe(4)
    expect(barWidthPercent(50, 100)).toBe(50)
  })
})
