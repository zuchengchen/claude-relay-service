const {
  parseFactoryUsageLimit,
  parseResetDurationMs,
  resolveFactoryPeriodEndMs,
  formatResetTime,
  RESET_BUFFER_MS
} = require('../src/utils/factoryUsageLimit')

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 8, 30, 1, 25, 56) // 2026-09-30 09:25:56 UTC+8

// 日志里的真实正文（流式分支拼好的字符串，detail 里带 \n）
const FIVE_HOUR_BODY =
  '{"detail":"You\'ve reached your 5-hour standard usage limit (resets in 1h 51min).\\nSwitch to Droid Core or enable Extra Usage to continue.","status":402,"title":"Payment Required","displayToUser":true,"error":{"detail":"You\'ve reached your 5-hour standard usage limit (resets in 1h 51min).\\nSwitch to Droid Core or enable Extra Usage to continue.","status":402,"title":"Payment Required","displayToUser":true},"requestId":"pdx1::wnrmc-1790731556452-97f6dc70dd14"}'

const WEEKLY_DETAIL =
  "You've reached your weekly standard usage limit (resets in 6 days).\nSwitch to Droid Core or enable Extra Usage to continue."

describe('parseFactoryUsageLimit', () => {
  it('parses the real 5-hour stream body', () => {
    const result = parseFactoryUsageLimit(FIVE_HOUR_BODY, NOW)

    expect(result).toEqual({
      window: 'fiveHour',
      kind: '5-hour',
      resetInMs: HOUR + 51 * MIN,
      resetAt: NOW + HOUR + 51 * MIN + RESET_BUFFER_MS,
      detail:
        "You've reached your 5-hour standard usage limit (resets in 1h 51min).\nSwitch to Droid Core or enable Extra Usage to continue."
    })
  })

  it('parses the weekly body given as an object (non-stream axios data)', () => {
    const result = parseFactoryUsageLimit(
      { detail: WEEKLY_DETAIL, status: 402, title: 'Payment Required' },
      NOW
    )

    expect(result.window).toBe('sevenDay')
    expect(result.resetInMs).toBe(6 * DAY)
    expect(result.resetAt).toBe(NOW + 6 * DAY + 90 * 1000)
    expect(result.detail).toBe(WEEKLY_DETAIL)
  })

  it('falls back to nested error.detail and error.message', () => {
    expect(parseFactoryUsageLimit({ error: { detail: WEEKLY_DETAIL } }, NOW).window).toBe(
      'sevenDay'
    )
    expect(
      parseFactoryUsageLimit(
        JSON.stringify({
          error: {
            message: "You've reached your 5-hour standard usage limit (resets in 0h 13min)."
          }
        }),
        NOW
      ).resetInMs
    ).toBe(13 * MIN)
  })

  it('accepts a Buffer and a Date', () => {
    const result = parseFactoryUsageLimit(Buffer.from(FIVE_HOUR_BODY), new Date(NOW))
    expect(result.window).toBe('fiveHour')
    expect(result.resetAt).toBe(NOW + HOUR + 51 * MIN + RESET_BUFFER_MS)
  })

  it('maps monthly / 30-day kinds to thirtyDay', () => {
    expect(
      parseFactoryUsageLimit(
        { detail: "You've reached your monthly standard usage limit (resets in 12 days)." },
        NOW
      ).window
    ).toBe('thirtyDay')
    expect(
      parseFactoryUsageLimit(
        { detail: "You've reached your 30-day standard usage limit (resets in 3 days)." },
        NOW
      ).window
    ).toBe('thirtyDay')
  })

  it('returns null for an unknown window kind', () => {
    expect(
      parseFactoryUsageLimit(
        { detail: "You've reached your daily standard usage limit (resets in 3h 2min)." },
        NOW
      )
    ).toBeNull()
  })

  it('returns null for a 402 that is not a usage limit', () => {
    expect(
      parseFactoryUsageLimit(
        '{"detail":"Payment required: please update your billing details","status":402}',
        NOW
      )
    ).toBeNull()
    expect(parseFactoryUsageLimit({ status: 402, title: 'Payment Required' }, NOW)).toBeNull()
  })

  it('returns null when the reset text cannot be parsed', () => {
    expect(
      parseFactoryUsageLimit(
        { detail: "You've reached your 5-hour standard usage limit (resets in a while)." },
        NOW
      )
    ).toBeNull()
  })

  it('tolerates malformed and empty bodies', () => {
    expect(parseFactoryUsageLimit('{"detail":"You\'ve reached your 5-hour', NOW)).toBeNull()
    expect(parseFactoryUsageLimit('', NOW)).toBeNull()
    expect(parseFactoryUsageLimit(null, NOW)).toBeNull()
    expect(parseFactoryUsageLimit(undefined, NOW)).toBeNull()
    expect(parseFactoryUsageLimit(402, NOW)).toBeNull()
    expect(parseFactoryUsageLimit('"just a string"', NOW)).toBeNull()
  })

  it('matches raw (non-JSON) text too', () => {
    const result = parseFactoryUsageLimit(WEEKLY_DETAIL, NOW)
    expect(result.window).toBe('sevenDay')
  })
})

describe('parseResetDurationMs', () => {
  it.each([
    ['2h 35min', 2 * HOUR + 35 * MIN],
    ['0h 13min', 13 * MIN],
    ['6 days', 6 * DAY],
    ['1 day', DAY],
    ['1 day 2 hours', DAY + 2 * HOUR],
    ['45 seconds', 45 * 1000],
    ['4h', 4 * HOUR]
  ])('%s', (text, expected) => {
    expect(parseResetDurationMs(text)).toBe(expected)
  })

  it('returns null when no unit is recognised', () => {
    expect(parseResetDurationMs('soon')).toBeNull()
    expect(parseResetDurationMs('')).toBeNull()
  })
})

describe('resolveFactoryPeriodEndMs', () => {
  const start = Date.UTC(2026, 8, 29, 7, 4)

  it('prefers endDate (ms or ISO) when present', () => {
    const end = start + 30 * DAY
    expect(resolveFactoryPeriodEndMs(start, end)).toBe(end)
    expect(resolveFactoryPeriodEndMs(start, new Date(end).toISOString())).toBe(end)
  })

  it('falls back to startDate + 7d', () => {
    expect(resolveFactoryPeriodEndMs(start, null)).toBe(start + 7 * DAY)
    expect(resolveFactoryPeriodEndMs(String(start), undefined)).toBe(start + 7 * DAY)
  })

  it('returns null without dates', () => {
    expect(resolveFactoryPeriodEndMs(null, null)).toBeNull()
    expect(resolveFactoryPeriodEndMs('not-a-date', '')).toBeNull()
  })
})

describe('formatResetTime', () => {
  it('formats in the given timezone offset', () => {
    expect(formatResetTime(Date.UTC(2026, 9, 6, 7, 4), 8)).toBe('2026-10-06 15:04 (UTC+8)')
    expect(formatResetTime(Date.UTC(2026, 9, 6, 23, 30), 8)).toBe('2026-10-07 07:30 (UTC+8)')
  })

  it('returns - for invalid input', () => {
    expect(formatResetTime(NaN, 8)).toBe('-')
    expect(formatResetTime(undefined, 8)).toBe('-')
  })
})
