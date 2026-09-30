/**
 * Factory（Droid）402 额度用尽正文解析
 *
 * 实测正文（日志里的 `Factory.ai error response body`）：
 *   {"detail":"You've reached your 5-hour standard usage limit (resets in 2h 35min).\nSwitch to
 *   Droid Core or enable Extra Usage to continue.","status":402,"title":"Payment Required",
 *   "error":{"detail":"...同上...","status":402}, ...}
 * 周额度的写法是 `weekly standard usage limit (resets in 6 days)`。
 *
 * Factory 的倒计时是向下取整的（"6 days" 实际可能是 6d 0h ~ 6d 23h），resetAt 额外加 90s 缓冲；
 * 周窗口的精确重置时间由 chat-usage 的 startDate + 7d 细化（见 droidUsageWindowService）。
 */

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const FIVE_HOUR_MS = 5 * HOUR_MS
const FACTORY_WEEK_MS = 7 * DAY_MS
const THIRTY_DAY_MS = 30 * DAY_MS
const RESET_BUFFER_MS = 90 * 1000

const USAGE_WINDOWS = ['fiveHour', 'sevenDay', 'thirtyDay']

const WINDOW_DURATION_MS = {
  fiveHour: FIVE_HOUR_MS,
  sevenDay: FACTORY_WEEK_MS,
  thirtyDay: THIRTY_DAY_MS
}

const USAGE_LIMIT_PATTERN = /reached your ([\w-]+) standard usage limit \(resets in ([^)]+)\)/i

const KIND_TO_WINDOW = {
  '5-hour': 'fiveHour',
  weekly: 'sevenDay',
  '7-day': 'sevenDay',
  monthly: 'thirtyDay',
  '30-day': 'thirtyDay'
}

// 按长到短排列，避免 `m` 抢先匹配 `min`
const DURATION_UNITS = [
  { pattern: /(\d+)\s*(?:days?|d)\b/, ms: DAY_MS },
  { pattern: /(\d+)\s*(?:hours?|hrs?|h)\b/, ms: HOUR_MS },
  { pattern: /(\d+)\s*(?:minutes?|mins?|m)\b/, ms: MINUTE_MS },
  { pattern: /(\d+)\s*(?:seconds?|secs?|s)\b/, ms: 1000 }
]

const pickDetail = (obj) => {
  if (!obj || typeof obj !== 'object') {
    return ''
  }
  const candidates = [obj.detail, obj.error?.detail, obj.error?.message]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate
    }
  }
  return ''
}

// 输入可以是字符串（流式拼好的 body）、Buffer 或对象（axios 解析后的 error.response.data）
const extractDetail = (body) => {
  if (body === null || body === undefined) {
    return ''
  }

  const value = Buffer.isBuffer(body) ? body.toString('utf8') : body

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return ''
    }
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') {
        return pickDetail(parsed)
      }
      return typeof parsed === 'string' ? parsed : ''
    } catch {
      // 非 JSON 文本：按原文匹配
      return trimmed
    }
  }

  return typeof value === 'object' ? pickDetail(value) : ''
}

// "2h 35min" / "0h 13min" / "6 days" → 毫秒；一个单位都识别不了时返回 null
const parseResetDurationMs = (text) => {
  const source = String(text || '').toLowerCase()
  let total = 0
  let matched = false

  for (const unit of DURATION_UNITS) {
    const match = unit.pattern.exec(source)
    if (match) {
      matched = true
      total += Number(match[1]) * unit.ms
    }
  }

  return matched ? total : null
}

const toEpochMs = (now) => {
  const value = now instanceof Date ? now.getTime() : Number(now)
  return Number.isFinite(value) ? value : Date.now()
}

/**
 * 解析 Factory 402 额度用尽正文
 * @param {string|object|Buffer} body - 上游 402 正文
 * @param {number|Date} now - 收到 402 的时间
 * @returns {{window: string, kind: string, resetAt: number, resetInMs: number, detail: string}|null}
 *   识别不了窗口或时间时返回 null，调用方走原有 402 逻辑
 */
function parseFactoryUsageLimit(body, now = Date.now()) {
  const detail = extractDetail(body)
  if (!detail) {
    return null
  }

  const match = USAGE_LIMIT_PATTERN.exec(detail)
  if (!match) {
    return null
  }

  const kind = match[1].toLowerCase()
  const window = KIND_TO_WINDOW[kind]
  if (!window) {
    return null
  }

  const resetInMs = parseResetDurationMs(match[2])
  if (resetInMs === null) {
    return null
  }

  return {
    window,
    kind,
    resetAt: toEpochMs(now) + resetInMs + RESET_BUFFER_MS,
    resetInMs,
    detail
  }
}

// 毫秒时间戳 / 数字字符串 / ISO 字符串 / Date → 毫秒；无法识别时返回 null
const toEpochMsOrNull = (value) => {
  if (value === null || value === undefined || value === '') {
    return null
  }
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : null
  }
  const numeric = Number(value)
  if (Number.isFinite(numeric)) {
    return numeric
  }
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * chat-usage 额度周期的结束（重置）时间，所有地方共用这一条规则：
 * endDate 有值就用 endDate；没有时按 startDate + 7d（实测 endDate 为 null，
 * startDate + 7d 与 weekly 402 的 "resets in N days" 对得上）
 * @returns {number|null} 毫秒时间戳
 */
const resolveFactoryPeriodEndMs = (startDate, endDate) => {
  const explicit = toEpochMsOrNull(endDate)
  if (explicit !== null) {
    return explicit
  }
  const start = toEpochMsOrNull(startDate)
  return start !== null ? start + FACTORY_WEEK_MS : null
}

const getTimezoneOffsetHours = () => {
  try {
    const config = require('../../config/config')
    // 与 redis.js 的 getDateInTimezone 保持一致
    return Number(config?.system?.timezoneOffset) || 8
  } catch {
    return 8
  }
}

// 按系统时区（默认 UTC+8，和日志、用量桶一致）格式化时间，例如 `2026-10-06 15:04 (UTC+8)`
const formatResetTime = (ms, offsetHours = getTimezoneOffsetHours()) => {
  const value = Number(ms)
  if (!Number.isFinite(value)) {
    return '-'
  }
  const shifted = new Date(value + offsetHours * HOUR_MS)
  const pad = (n) => String(n).padStart(2, '0')
  const sign = offsetHours >= 0 ? '+' : '-'
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(
    shifted.getUTCDate()
  )} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())} (UTC${sign}${Math.abs(
    offsetHours
  )})`
}

module.exports = {
  parseFactoryUsageLimit,
  parseResetDurationMs,
  resolveFactoryPeriodEndMs,
  formatResetTime,
  USAGE_WINDOWS,
  WINDOW_DURATION_MS,
  FIVE_HOUR_MS,
  FACTORY_WEEK_MS,
  THIRTY_DAY_MS,
  RESET_BUFFER_MS
}
