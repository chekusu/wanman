/**
 * Unit tests for CronScheduler — cron expression parsing and scheduling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CronScheduler, parseCron, matchesCron, type CronCallback } from '../cron-scheduler.js'

// Mock logger
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

// =========================================================================
// Cron expression parser
// =========================================================================

describe('parseCron', () => {
  it('should parse "0 8 * * *" (daily at 08:00)', () => {
    const schedule = parseCron('0 8 * * *')

    expect(schedule.minutes.has(0)).toBe(true)
    expect(schedule.minutes.size).toBe(1)
    expect(schedule.hours.has(8)).toBe(true)
    expect(schedule.hours.size).toBe(1)
    expect(schedule.daysOfMonth.size).toBe(31) // all days
    expect(schedule.months.size).toBe(12) // all months
    expect(schedule.daysOfWeek.size).toBe(7) // all days of week
  })

  it('should parse "0 * * * *" (every hour)', () => {
    const schedule = parseCron('0 * * * *')

    expect(schedule.minutes.has(0)).toBe(true)
    expect(schedule.minutes.size).toBe(1)
    expect(schedule.hours.size).toBe(24) // all hours
  })

  it('should parse "0 9 * * 1" (Mondays at 09:00)', () => {
    const schedule = parseCron('0 9 * * 1')

    expect(schedule.minutes.has(0)).toBe(true)
    expect(schedule.hours.has(9)).toBe(true)
    expect(schedule.daysOfWeek.has(1)).toBe(true)
    expect(schedule.daysOfWeek.size).toBe(1)
  })

  it('should parse "*/15 * * * *" (every 15 minutes)', () => {
    const schedule = parseCron('*/15 * * * *')

    expect(schedule.minutes.has(0)).toBe(true)
    expect(schedule.minutes.has(15)).toBe(true)
    expect(schedule.minutes.has(30)).toBe(true)
    expect(schedule.minutes.has(45)).toBe(true)
    expect(schedule.minutes.size).toBe(4)
  })

  it('should parse ranges: "1-5" in day-of-week', () => {
    const schedule = parseCron('0 9 * * 1-5')

    expect(schedule.daysOfWeek.size).toBe(5)
    for (let i = 1; i <= 5; i++) {
      expect(schedule.daysOfWeek.has(i)).toBe(true)
    }
    expect(schedule.daysOfWeek.has(0)).toBe(false) // Sunday
    expect(schedule.daysOfWeek.has(6)).toBe(false) // Saturday
  })

  it('should parse lists: "1,3,5" in day-of-week', () => {
    const schedule = parseCron('0 9 * * 1,3,5')

    expect(schedule.daysOfWeek.size).toBe(3)
    expect(schedule.daysOfWeek.has(1)).toBe(true)
    expect(schedule.daysOfWeek.has(3)).toBe(true)
    expect(schedule.daysOfWeek.has(5)).toBe(true)
  })

  it('should parse step with range: "0-30/10"', () => {
    const schedule = parseCron('0-30/10 * * * *')

    expect(schedule.minutes.has(0)).toBe(true)
    expect(schedule.minutes.has(10)).toBe(true)
    expect(schedule.minutes.has(20)).toBe(true)
    expect(schedule.minutes.has(30)).toBe(true)
    expect(schedule.minutes.size).toBe(4)
  })

  it.each(['0-60', '12-8', '6-60/2', '61/2', '5x', '*/2x', '1-4-6', '*/2/2', '1,'])(
    'rejects invalid minute field %s at registration', field => {
      const scheduler = new CronScheduler(vi.fn())
      expect(() => scheduler.addJob('worker', field + ' * * * *')).toThrow()
      expect(scheduler.getJobs()).toHaveLength(0)
    }
  )

  it('accepts Sunday as either 0 or 7, including in ranges', () => {
    expect(parseCron('0 8 * * 6-7').daysOfWeek).toEqual(new Set([6, 0]))
  })

  it('should throw on invalid expression (wrong number of fields)', () => {
    expect(() => parseCron('0 8 *')).toThrow('expected 5 fields')
  })

  it('should throw on invalid value out of range', () => {
    expect(() => parseCron('60 * * * *')).toThrow('Invalid value')
  })

  it('should throw on invalid step', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow('Invalid step')
  })
})

// =========================================================================
// matchesCron
// =========================================================================

describe('matchesCron', () => {
  it('allows either restricted day field to match but still requires the month and time', () => {
    const schedule = parseCron('0 8 1 2 1')
    expect(matchesCron(schedule, new Date(2026, 1, 1, 8))).toBe(true)  // Sunday, first of February
    expect(matchesCron(schedule, new Date(2026, 1, 2, 8))).toBe(true)  // Monday, second of February
    expect(matchesCron(schedule, new Date(2026, 1, 3, 8))).toBe(false)
    expect(matchesCron(schedule, new Date(2026, 2, 1, 8))).toBe(false)
  })

  it('uses both fields when a day field starts with an asterisk', () => {
    const schedule = parseCron('0 8 */2 * 1')
    expect(matchesCron(schedule, new Date(2026, 1, 9, 8))).toBe(true)
    expect(matchesCron(schedule, new Date(2026, 1, 2, 8))).toBe(false)
    expect(matchesCron(schedule, new Date(2026, 1, 1, 8))).toBe(false)
  })

  it('should match "0 8 * * *" at 08:00 on any day', () => {
    const schedule = parseCron('0 8 * * *')
    // Wednesday, Feb 26, 2026, 08:00
    const date = new Date(2026, 1, 26, 8, 0)
    expect(matchesCron(schedule, date)).toBe(true)
  })

  it('should not match "0 8 * * *" at 09:00', () => {
    const schedule = parseCron('0 8 * * *')
    const date = new Date(2026, 1, 26, 9, 0)
    expect(matchesCron(schedule, date)).toBe(false)
  })

  it('should not match "0 8 * * *" at 08:01', () => {
    const schedule = parseCron('0 8 * * *')
    const date = new Date(2026, 1, 26, 8, 1)
    expect(matchesCron(schedule, date)).toBe(false)
  })

  it('should match "0 * * * *" at any hour :00', () => {
    const schedule = parseCron('0 * * * *')
    expect(matchesCron(schedule, new Date(2026, 0, 1, 0, 0))).toBe(true)
    expect(matchesCron(schedule, new Date(2026, 0, 1, 12, 0))).toBe(true)
    expect(matchesCron(schedule, new Date(2026, 0, 1, 23, 0))).toBe(true)
  })

  it('should not match "0 * * * *" at :30', () => {
    const schedule = parseCron('0 * * * *')
    expect(matchesCron(schedule, new Date(2026, 0, 1, 12, 30))).toBe(false)
  })

  it('should match "0 9 * * 1" only on Mondays', () => {
    const schedule = parseCron('0 9 * * 1')
    // Feb 23, 2026 is a Monday
    expect(matchesCron(schedule, new Date(2026, 1, 23, 9, 0))).toBe(true)
    // Feb 24, 2026 is a Tuesday
    expect(matchesCron(schedule, new Date(2026, 1, 24, 9, 0))).toBe(false)
  })

  it('should match "*/15 * * * *" at :00, :15, :30, :45', () => {
    const schedule = parseCron('*/15 * * * *')
    expect(matchesCron(schedule, new Date(2026, 0, 1, 0, 0))).toBe(true)
    expect(matchesCron(schedule, new Date(2026, 0, 1, 0, 15))).toBe(true)
    expect(matchesCron(schedule, new Date(2026, 0, 1, 0, 30))).toBe(true)
    expect(matchesCron(schedule, new Date(2026, 0, 1, 0, 45))).toBe(true)
    expect(matchesCron(schedule, new Date(2026, 0, 1, 0, 10))).toBe(false)
  })
})

// =========================================================================
// CronScheduler
// =========================================================================

describe('CronScheduler', () => {
  let callback: CronCallback
  let callbackMock: ReturnType<typeof vi.fn>
  let scheduler: CronScheduler

  beforeEach(() => {
    callbackMock = vi.fn()
    callback = callbackMock as CronCallback
    scheduler = new CronScheduler(callback)
  })

  afterEach(() => {
    scheduler.stop()
  })

  it('should register jobs', () => {
    scheduler.addJob('ceo', '0 8 * * *')
    scheduler.addJob('finance', '0 9 * * *')

    expect(scheduler.getJobs()).toHaveLength(2)
    expect(scheduler.getJobs()[0]!.agent).toBe('ceo')
    expect(scheduler.getJobs()[1]!.agent).toBe('finance')
  })

  it('should trigger callback when cron matches', () => {
    scheduler.addJob('ceo', '0 8 * * *')

    // Tick at 08:00
    scheduler.tick(new Date(2026, 1, 26, 8, 0))

    expect(callbackMock).toHaveBeenCalledWith('ceo', '0 8 * * *')
  })

  it('should not trigger callback when cron does not match', () => {
    scheduler.addJob('ceo', '0 8 * * *')

    // Tick at 09:00
    scheduler.tick(new Date(2026, 1, 26, 9, 0))

    expect(callbackMock).not.toHaveBeenCalled()
  })

  it('should trigger multiple agents when their crons match', () => {
    scheduler.addJob('ceo', '0 8 * * *')
    scheduler.addJob('finance', '0 8 * * *')

    scheduler.tick(new Date(2026, 1, 26, 8, 0))

    expect(callbackMock).toHaveBeenCalledTimes(2)
    expect(callbackMock).toHaveBeenCalledWith('ceo', '0 8 * * *')
    expect(callbackMock).toHaveBeenCalledWith('finance', '0 8 * * *')
  })

  it('fires each registered job once per observed minute', () => {
    scheduler.addJob('ceo', '* * * * *')
    scheduler.tick(new Date(2026, 1, 26, 8, 0, 10))
    scheduler.tick(new Date(2026, 1, 26, 8, 0, 45))
    scheduler.tick(new Date(2026, 1, 26, 8, 1))
    expect(callbackMock).toHaveBeenCalledTimes(2)
  })

  it('should handle multiple crons per agent', () => {
    scheduler.addJob('finance', '0 9 * * *')
    scheduler.addJob('finance', '0 9 * * 1')

    // Monday at 09:00 — both crons match
    scheduler.tick(new Date(2026, 1, 23, 9, 0))

    expect(callbackMock).toHaveBeenCalledTimes(2)
  })

  it('should handle callback errors without crashing', () => {
    callbackMock.mockImplementation(() => { throw new Error('test error') })
    scheduler.addJob('ceo', '0 8 * * *')

    // Should not throw
    expect(() => scheduler.tick(new Date(2026, 1, 26, 8, 0))).not.toThrow()
  })

  it('should start and stop the timer', () => {
    scheduler.addJob('ceo', '0 8 * * *')

    scheduler.start()
    // start again should be idempotent
    scheduler.start()

    scheduler.stop()
    // stop again should be safe
    scheduler.stop()
  })

  it('should work with production agent cron expressions', () => {
    // CEO: morning briefing
    scheduler.addJob('ceo', '0 8 * * *')
    // Finance: daily + weekly
    scheduler.addJob('finance', '0 9 * * *')
    scheduler.addJob('finance', '0 9 * * 1')
    // DevOps: hourly
    scheduler.addJob('devops', '0 * * * *')
    // Marketing: daily
    scheduler.addJob('marketing', '0 10 * * *')
    // Feedback: daily
    scheduler.addJob('feedback', '0 11 * * *')

    expect(scheduler.getJobs()).toHaveLength(6)

    // Monday 08:00 — CEO fires
    callbackMock.mockClear()
    scheduler.tick(new Date(2026, 1, 23, 8, 0))
    expect(callbackMock).toHaveBeenCalledWith('ceo', '0 8 * * *')
    // DevOps also fires at :00
    expect(callbackMock).toHaveBeenCalledWith('devops', '0 * * * *')

    // Monday 09:00 — Finance fires twice (daily + weekly), DevOps fires
    callbackMock.mockClear()
    scheduler.tick(new Date(2026, 1, 23, 9, 0))
    expect(callbackMock).toHaveBeenCalledTimes(3) // finance daily + finance weekly + devops hourly

    // Tuesday 09:00 — Finance fires once (daily only), DevOps fires
    callbackMock.mockClear()
    scheduler.tick(new Date(2026, 1, 24, 9, 0))
    expect(callbackMock).toHaveBeenCalledTimes(2) // finance daily + devops hourly
  })
})
