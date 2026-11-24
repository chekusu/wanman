// Cron Scheduler — triggers agents at scheduled times.
//
// Supports standard 5-field cron expressions:
//   minute hour day-of-month month day-of-week
//
// Examples:
//   '0 8 * * *'     — every day at 08:00
//   '0 * * * *'     — every hour at :00
//   '0 9 * * 1'     — every Monday at 09:00
//   '*/15 * * * *'  — every 15 minutes

import { createLogger } from './logger.js';

const log = createLogger('cron-scheduler');

/** Check interval — every 60 seconds */
const CHECK_INTERVAL_MS = 60_000;

export interface CronJob {
  /** Agent name */
  agent: string;
  /** Original cron expression */
  expression: string;
  /** Parsed schedule */
  schedule: ParsedCron;
}

interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  bothDayFieldsRestricted: boolean;
}

export type CronCallback = (agent: string, expression: string) => void;

export class CronScheduler {
  private jobs: CronJob[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private callback: CronCallback;
  private lastCheckedMinute: number | null = null;

  constructor(callback: CronCallback) {
    this.callback = callback;
  }

  /** Register a cron job for an agent. */
  addJob(agent: string, expression: string): void {
    const schedule = parseCron(expression);
    this.jobs.push({ agent, expression, schedule });
    log.info('cron job registered', { agent, expression });
  }

  /** Start the scheduler loop. */
  start(): void {
    if (this.timer) return;

    this.lastCheckedMinute = Math.floor(Date.now() / CHECK_INTERVAL_MS);

    this.timer = setInterval(() => {
      this.tick();
    }, CHECK_INTERVAL_MS);

    // Don't keep the process alive just for this timer
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }

    log.info('cron scheduler started', { jobCount: this.jobs.length });
  }

  /** Stop the scheduler loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info('cron scheduler stopped');
    }
  }

  /** Manual tick — check all jobs against current time. Exposed for testing. */
  tick(now?: Date): void {
    const current = now || new Date();
    const minute = Math.floor(current.getTime() / CHECK_INTERVAL_MS);
    if (minute === this.lastCheckedMinute) return;
    this.lastCheckedMinute = minute;

    for (const job of this.jobs) {
      if (matchesCron(job.schedule, current)) {
        log.info('cron triggered', { agent: job.agent, expression: job.expression });
        try {
          this.callback(job.agent, job.expression);
        } catch (err) {
          log.error('cron callback error', {
            agent: job.agent,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  /** Get all registered jobs (for testing/debugging). */
  getJobs(): ReadonlyArray<CronJob> {
    return this.jobs;
  }
}

// ── Cron Expression Parser ──

// Parse a standard 5-field cron expression.
//
// Fields: minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-7, 0 and 7=Sun)
//
// Supports: *, specific values, ranges (1-5), steps (star/15), lists (1,3,5)
export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: "${expression}" — expected 5 fields, got ${parts.length}`);
  }

  const daysOfWeek = parseField(parts[4]!, 0, 7);
  if (daysOfWeek.delete(7)) daysOfWeek.add(0);
  return {
    minutes: parseField(parts[0]!, 0, 59),
    hours: parseField(parts[1]!, 0, 23),
    daysOfMonth: parseField(parts[2]!, 1, 31),
    months: parseField(parts[3]!, 1, 12),
    daysOfWeek,
    bothDayFieldsRestricted: !parts[2]!.startsWith('*') && !parts[4]!.startsWith('*'),
  };
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const match = /^(\*|[0-9]+)(?:-([0-9]+))?(?:\/([0-9]+))?$/.exec(part);
    if (!match || (match[1] === '*' && match[2] !== undefined)) {
      throw new Error(`Invalid value in cron field: "${part}"`);
    }

    const [, first, last, increment] = match;
    const start = first === '*' ? min : Number(first);
    // A step on a single value (e.g. 5/10) runs from that value to the field maximum.
    let end = start;
    if (last !== undefined) end = Number(last);
    else if (first === '*' || increment !== undefined) end = max;
    const step = increment === undefined ? 1 : Number(increment);
    if (!Number.isSafeInteger(step) || step < 1) {
      throw new Error(`Invalid step in cron field: "${part}"`);
    }
    if (start < min || end > max || start > end) {
      throw new Error(`Invalid value in cron field: "${part}" (valid range: ${min}-${max})`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }

  return values;
}

/** Check if a date matches a parsed cron schedule. */
export function matchesCron(schedule: ParsedCron, date: Date): boolean {
  const monthDay = schedule.daysOfMonth.has(date.getDate());
  const weekDay = schedule.daysOfWeek.has(date.getDay());
  const dayMatches = schedule.bothDayFieldsRestricted ? monthDay || weekDay : monthDay && weekDay;
  return (
    schedule.minutes.has(date.getMinutes()) &&
    schedule.hours.has(date.getHours()) &&
    schedule.months.has(date.getMonth() + 1) &&
    dayMatches
  );
}
