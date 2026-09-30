const redis = require('../models/redis')
const logger = require('../utils/logger')
const droidUsageLimitService = require('./droidUsageLimitService')
const {
  FIVE_HOUR_MS,
  FACTORY_WEEK_MS,
  THIRTY_DAY_MS,
  RESET_BUFFER_MS,
  formatResetTime,
  resolveFactoryPeriodEndMs
} = require('../utils/factoryUsageLimit')

/**
 * Droid（Factory）5h / 7d / 30d 额度窗口与月额度估算
 *
 * - 7d：Factory chat-usage（usage.standard.userTokens / totalAllowance，usage.startDate + 7d 重置），精确值
 * - 5h：窗口从第一次成功转发开始计时（SET NX），开窗后拉一次快照记 baseline；
 *       同一 Factory 周内 used = userTokens - baseline，否则按「本地 relay 费用 / 比率」估算
 * - 30d：窗口内每个 Factory 周见过的最大 userTokens（触发过周限额的已结束周至少按 allowance），估算值
 * - 402 限额记录（droidUsageLimitService）优先：对应窗口直接显示 100% 和精确倒计时，并记上限样本
 *
 * 快照只读取当前存储的凭证，不刷新 token（refreshAccessToken 没有锁，WorkOS refresh token 会轮换）。
 * 这里的一切只影响展示，调度只依赖 402 限额记录。
 */

const DEFAULT_TOTAL_ALLOWANCE = 20000000
const RATIO_MIN_TOKENS = 2000000
const MIN_FIVE_HOUR_SAMPLES = 3
const MIN_THIRTY_DAY_SAMPLES = 1
const MAX_CAP_SAMPLES = 50
const RECORD_TTL_SECONDS = 35 * 24 * 3600
const SNAPSHOT_RETENTION_SECONDS = 7 * 24 * 3600
const BASELINE_ALIGN_TOLERANCE_MS = 15 * 60 * 1000
const WEEK_REFINE_TOLERANCE_MS = 5 * 60 * 1000
const SNAPSHOT_CONCURRENCY = 3
const TOKENS_PER_M = 1000000

const DEFAULT_SETTINGS = Object.freeze({
  fiveHourCapRatio: 0.3,
  thirtyDayCapTokens: null,
  defaultUsdPerMTokens: 0.9,
  snapshotCacheSeconds: 120
})

const KEYS = {
  window5h: (accountId) => `droid:usage_window:5h:${accountId}`,
  window30d: (accountId) => `droid:usage_window:30d:${accountId}`,
  week: (accountId) => `droid:usage_week:${accountId}`,
  capSamples: (kind) => `droid:usage_cap_samples:${kind}`,
  capClaim: (kind, accountId, eventId) => `droid:usage_cap_claim:${kind}:${accountId}:${eventId}`,
  snapshot: (accountId) => `droid:usage_snapshot:${accountId}`
}

// ==================== 通用小工具 ====================

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

const toEpochOrNull = (value) => {
  const num = toNumberOrNull(value)
  if (num !== null) {
    return num
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const positiveOr = (value, fallback) => {
  const num = toNumberOrNull(value)
  return num !== null && num > 0 ? num : fallback
}

const parseJson = (raw) => {
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const roundTo = (value, digits = 2) => {
  if (!Number.isFinite(value)) {
    return null
  }
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const toIso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)

const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) {
    return null
  }
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

// config/config.js 是本地文件，不一定有 droidUsage 段，每一项都要有默认值
const getSettings = () => {
  let section = {}
  try {
    section = require('../../config/config')?.droidUsage || {}
  } catch {
    section = {}
  }
  return {
    fiveHourCapRatio: positiveOr(section.fiveHourCapRatio, DEFAULT_SETTINGS.fiveHourCapRatio),
    thirtyDayCapTokens: positiveOr(section.thirtyDayCapTokens, null),
    defaultUsdPerMTokens: positiveOr(
      section.defaultUsdPerMTokens,
      DEFAULT_SETTINGS.defaultUsdPerMTokens
    ),
    snapshotCacheSeconds: positiveOr(
      section.snapshotCacheSeconds,
      DEFAULT_SETTINGS.snapshotCacheSeconds
    )
  }
}

// ==================== 记录解析 ====================

// 快照只保留用量字段，不含任何凭证
const buildSnapshot = (usage, fetchedAt) => {
  const standard = usage?.standard || {}
  return {
    userTokens: toNumberOrNull(standard.userTokens) ?? 0,
    totalAllowance: toNumberOrNull(standard.totalAllowance),
    orgOverageUsed: toNumberOrNull(standard.orgOverageUsed) ?? 0,
    usedRatio: toNumberOrNull(standard.usedRatio),
    startDate: toEpochOrNull(usage?.startDate),
    endDate: toEpochOrNull(usage?.endDate),
    fetchedAt
  }
}

const parseSnapshotRecord = (raw) => {
  const parsed = parseJson(raw)
  if (!parsed || !Number.isFinite(Number(parsed.fetchedAt))) {
    return null
  }
  return {
    userTokens: toNumberOrNull(parsed.userTokens) ?? 0,
    totalAllowance: toNumberOrNull(parsed.totalAllowance),
    orgOverageUsed: toNumberOrNull(parsed.orgOverageUsed) ?? 0,
    usedRatio: toNumberOrNull(parsed.usedRatio),
    startDate: toNumberOrNull(parsed.startDate),
    endDate: toNumberOrNull(parsed.endDate),
    fetchedAt: Number(parsed.fetchedAt)
  }
}

const parseWindowRecord = (raw) => {
  const parsed = parseJson(raw)
  if (!parsed) {
    return null
  }
  const start = toNumberOrNull(parsed.start)
  const end = toNumberOrNull(parsed.end)
  if (start === null || end === null || end <= start) {
    return null
  }
  return {
    start,
    end,
    baselineTokens: toNumberOrNull(parsed.baselineTokens),
    baselineStartDate: toNumberOrNull(parsed.baselineStartDate),
    baselineAt: toNumberOrNull(parsed.baselineAt),
    capSampled: parsed.capSampled === true
  }
}

const parseWeekHash = (hash) =>
  Object.values(hash || {})
    .map((raw) => parseJson(raw))
    .filter((week) => week && Number.isFinite(Number(week.startDate)))
    .map((week) => ({
      startDate: Number(week.startDate),
      endDate: toNumberOrNull(week.endDate),
      maxUserTokens: toNumberOrNull(week.maxUserTokens) ?? 0,
      totalAllowance: toNumberOrNull(week.totalAllowance),
      capped: week.capped === true,
      lastSeenAt: toNumberOrNull(week.lastSeenAt)
    }))
    .sort((a, b) => a.startDate - b.startDate)

// ==================== 纯计算 ====================

// 周期结束时间与余额列（droidBalanceProvider）同一规则：endDate 优先，否则 startDate + 7d
const weekEndOf = (record) =>
  Number.isFinite(record?.startDate)
    ? resolveFactoryPeriodEndMs(record.startDate, record.endDate)
    : null

// 快照所在的 Factory 周是否还没结束（没有 startDate 时视为当前周）
const isSnapshotWeekCurrent = (snapshot, now) => {
  if (!snapshot) {
    return false
  }
  const weekEnd = weekEndOf(snapshot)
  return weekEnd === null || weekEnd > now
}

/**
 * 上限样本 → 上限 token 数
 * 样本按 capTokens / totalAllowance 归一化后取中位数，再乘当前账号的 allowance
 * @returns {{cap: number, count: number}|null} 样本不足 minCount 时返回 null
 */
const capFromSamples = (samples, minCount, allowance) => {
  const valid = (samples || []).filter((sample) => Number(sample?.capTokens) > 0)
  if (valid.length < minCount) {
    return null
  }
  const ratios = valid
    .filter((sample) => Number(sample.totalAllowance) > 0)
    .map((sample) => Number(sample.capTokens) / Number(sample.totalAllowance))
  if (ratios.length >= minCount && allowance > 0) {
    return { cap: median(ratios) * allowance, count: valid.length }
  }
  return { cap: median(valid.map((sample) => Number(sample.capTokens))), count: valid.length }
}

/**
 * 30d 用量：窗口内每个 Factory 周取见过的最大 userTokens；
 * 已结束且触发过周限额的周至少按 totalAllowance 计（真实用量不低于周额度）
 */
const sumWeekTokens = ({ weeks = [], snapshot = null, since, now }) => {
  const merged = new Map()
  for (const week of weeks) {
    if (Number.isFinite(week?.startDate)) {
      merged.set(week.startDate, { ...week })
    }
  }
  if (snapshot && Number.isFinite(snapshot.startDate)) {
    const existing = merged.get(snapshot.startDate)
    merged.set(snapshot.startDate, {
      startDate: snapshot.startDate,
      endDate: snapshot.endDate ?? existing?.endDate ?? null,
      maxUserTokens: Math.max(existing?.maxUserTokens || 0, snapshot.userTokens || 0),
      totalAllowance: snapshot.totalAllowance ?? existing?.totalAllowance ?? null,
      capped: existing?.capped === true
    })
  }

  let tokens = 0
  let weeksCounted = 0
  let coveredUntil = null
  for (const week of merged.values()) {
    const weekEnd = weekEndOf(week)
    if (weekEnd <= since || week.startDate > now) {
      continue
    }
    const ended = weekEnd <= now
    const floor =
      ended && week.capped && Number.isFinite(week.totalAllowance) ? week.totalAllowance : 0
    tokens += Math.max(week.maxUserTokens || 0, floor)
    weeksCounted += 1
    coveredUntil = Math.max(coveredUntil ?? 0, weekEnd)
  }
  return { tokens, weeksCounted, coveredUntil }
}

const thirtyDaySinceOf = (window30d, now) =>
  window30d && window30d.end > now ? window30d.start : now - THIRTY_DAY_MS

/**
 * 需要查询本地费用的起点
 * - week：本周 relay 费用（算本账号比率），仅快照新鲜且本周未结束时
 * - sevenDayFallback：没有可用的本周快照时，7d 用量的本地估算起点
 * - fiveHour：5h 窗口起点
 * - thirtyDay：30d 里周记录覆盖不到的部分
 */
const planCostSinces = ({ snapshot = null, stale = false, window5h, window30d, weeks, now }) => {
  const sinces = {}
  const weekEnd = weekEndOf(snapshot)

  if (snapshot && isSnapshotWeekCurrent(snapshot, now)) {
    if (!stale && Number.isFinite(snapshot.startDate)) {
      sinces.week = snapshot.startDate
    }
  } else {
    sinces.sevenDayFallback = weekEnd !== null ? weekEnd : now - FACTORY_WEEK_MS
  }

  if (window5h && window5h.end > now) {
    sinces.fiveHour = window5h.start
  }

  const thirtySince = thirtyDaySinceOf(window30d, now)
  const { weeksCounted, coveredUntil } = sumWeekTokens({ weeks, snapshot, since: thirtySince, now })
  if (weeksCounted === 0) {
    sinces.thirtyDay = thirtySince
  } else if (coveredUntil < now) {
    sinces.thirtyDay = coveredUntil
  }

  return sinces
}

/**
 * 比率（美元 / 百万 Factory token）
 * 本账号本周 relay 费用 / userTokens（userTokens ≥ 2M）→ 池子加权比率 → 配置默认值
 */
const resolveRatio = ({ snapshot, stale, costs = {}, poolRatio, settings, now }) => {
  const tokens = snapshot?.userTokens || 0
  const weekCost = costs.week
  if (
    snapshot &&
    !stale &&
    isSnapshotWeekCurrent(snapshot, now) &&
    tokens >= RATIO_MIN_TOKENS &&
    Number.isFinite(weekCost) &&
    weekCost > 0
  ) {
    return { usdPerMTokens: (weekCost / tokens) * TOKENS_PER_M, source: 'account' }
  }
  if (Number.isFinite(poolRatio) && poolRatio > 0) {
    return { usdPerMTokens: poolRatio, source: 'pool' }
  }
  return { usdPerMTokens: settings.defaultUsdPerMTokens, source: 'default' }
}

// 池子加权比率：所有「快照新鲜且本周有 relay 费用」的账号合计
const computePoolRatio = (entries, now) => {
  let cost = 0
  let tokens = 0
  for (const entry of entries) {
    const { snapshot, stale } = entry?.snapshotResult || {}
    const weekCost = entry?.costs?.week
    if (
      !snapshot ||
      stale ||
      !isSnapshotWeekCurrent(snapshot, now) ||
      !(snapshot.userTokens > 0) ||
      !Number.isFinite(weekCost) ||
      weekCost <= 0
    ) {
      continue
    }
    cost += weekCost
    tokens += snapshot.userTokens
  }
  return tokens >= RATIO_MIN_TOKENS && cost > 0 ? (cost / tokens) * TOKENS_PER_M : null
}

const resolveThirtyDayCap = (settings, samples, allowance) => {
  if (settings.thirtyDayCapTokens > 0) {
    return { cap: settings.thirtyDayCapTokens, source: 'config', count: 0 }
  }
  const fromSamples = capFromSamples(samples, MIN_THIRTY_DAY_SAMPLES, allowance)
  if (fromSamples) {
    return { cap: fromSamples.cap, source: 'samples', count: fromSamples.count }
  }
  return { cap: allowance * (THIRTY_DAY_MS / FACTORY_WEEK_MS), source: 'default', count: 0 }
}

// 有限额记录时：util 至少 100，resetAt 取限额记录
const applyLimit = (win, limit) => {
  const util = win.cap > 0 ? (win.used / win.cap) * 100 : 0
  if (limit) {
    return {
      ...win,
      util: Math.max(util, 100),
      resetAtMs: limit.resetAt,
      limited: true,
      limitDetail: limit.detail || ''
    }
  }
  return { ...win, util, limited: false, limitDetail: null }
}

const formatWindowOutput = (win) => ({
  util: roundTo(win.util, 1),
  used: Math.round(win.used || 0),
  cap: Math.round(win.cap || 0),
  resetAt: toIso(win.resetAtMs),
  windowStart: toIso(win.windowStartMs),
  estimated: win.estimated === true,
  limited: win.limited === true,
  limitDetail: win.limitDetail || null,
  source: win.source,
  capSource: win.capSource || null,
  capSampleCount: win.capSampleCount || 0,
  capRatio: Number.isFinite(win.capRatio) ? win.capRatio : null,
  capMinSamples: Number.isFinite(win.capMinSamples) ? win.capMinSamples : null
})

/**
 * 单账号的三窗口计算（纯函数，所有外部数据由调用方准备好）
 */
function computeAccountWindows({
  account,
  snapshotResult = {},
  limits = {},
  window5h = null,
  window30d = null,
  weeks = [],
  capSamples = {},
  costs = {},
  poolRatio = null,
  settings = DEFAULT_SETTINGS,
  now = Date.now()
}) {
  const { snapshot = null, stale = false, error = null } = snapshotResult || {}
  const totalAllowance = snapshot?.totalAllowance > 0 ? snapshot.totalAllowance : null
  const allowance = totalAllowance ?? DEFAULT_TOTAL_ALLOWANCE
  const weekCurrent = isSnapshotWeekCurrent(snapshot, now)

  const ratio = resolveRatio({ snapshot, stale, costs, poolRatio, settings, now })
  const tokensFromCost = (cost) =>
    ratio.usdPerMTokens > 0 ? ((Number(cost) || 0) / ratio.usdPerMTokens) * TOKENS_PER_M : 0

  // ---- 7d：chat-usage 精确值 ----
  let sevenDay
  if (snapshot && weekCurrent) {
    sevenDay = {
      used: snapshot.userTokens || 0,
      cap: allowance,
      resetAtMs: weekEndOf(snapshot),
      windowStartMs: snapshot.startDate,
      estimated: false,
      source: 'chat-usage'
    }
  } else {
    sevenDay = {
      used: tokensFromCost(costs.sevenDayFallback),
      cap: allowance,
      resetAtMs: null,
      windowStartMs: null,
      estimated: true,
      source: 'local'
    }
  }

  // ---- 5h：baseline 差值或本地估算 ----
  let fiveHour
  if (window5h && window5h.end > now) {
    const baselineUsable =
      Number.isFinite(window5h.baselineTokens) &&
      snapshot &&
      !stale &&
      Number.isFinite(snapshot.startDate) &&
      window5h.baselineStartDate === snapshot.startDate
    fiveHour = {
      used: baselineUsable
        ? Math.max(0, (snapshot.userTokens || 0) - window5h.baselineTokens)
        : tokensFromCost(costs.fiveHour),
      resetAtMs: window5h.end,
      windowStartMs: window5h.start,
      source: baselineUsable ? 'baseline' : 'local'
    }
  } else {
    fiveHour = { used: 0, resetAtMs: null, windowStartMs: null, source: 'idle' }
  }
  const fiveHourSamples = capSamples.fiveHour || []
  const fiveHourCap = capFromSamples(fiveHourSamples, MIN_FIVE_HOUR_SAMPLES, allowance)
  fiveHour.cap = fiveHourCap ? fiveHourCap.cap : allowance * settings.fiveHourCapRatio
  fiveHour.capSource = fiveHourCap ? 'samples' : 'default'
  fiveHour.capSampleCount = fiveHourSamples.length
  // 前端 tooltip 按实际生效的比例和样本门槛显示，不写死
  fiveHour.capRatio = settings.fiveHourCapRatio
  fiveHour.capMinSamples = MIN_FIVE_HOUR_SAMPLES
  fiveHour.estimated = true

  // ---- 30d：周记录汇总 + 未覆盖部分的本地估算 ----
  const thirtyActive = window30d && window30d.end > now
  const weekSum = sumWeekTokens({
    weeks,
    snapshot,
    since: thirtyDaySinceOf(window30d, now),
    now
  })
  let thirtyUsed
  let thirtySource
  if (weekSum.weeksCounted > 0) {
    thirtyUsed = weekSum.tokens + (weekSum.coveredUntil < now ? tokensFromCost(costs.thirtyDay) : 0)
    thirtySource = 'weeks'
  } else {
    thirtyUsed = tokensFromCost(costs.thirtyDay)
    thirtySource = 'local'
  }
  const thirtyCap = resolveThirtyDayCap(settings, capSamples.thirtyDay || [], allowance)
  const thirtyDay = {
    used: thirtyUsed,
    cap: thirtyCap.cap,
    capSource: thirtyCap.source,
    capSampleCount: (capSamples.thirtyDay || []).length,
    resetAtMs: thirtyActive ? window30d.end : null,
    windowStartMs: thirtyActive ? window30d.start : null,
    estimated: !limits.thirtyDay,
    source: thirtySource
  }

  const windows = {
    fiveHour: formatWindowOutput(applyLimit(fiveHour, limits.fiveHour)),
    sevenDay: formatWindowOutput(applyLimit(sevenDay, limits.sevenDay)),
    thirtyDay: formatWindowOutput(applyLimit(thirtyDay, limits.thirtyDay))
  }

  return {
    accountId: account?.id || null,
    autoProtectionDisabled:
      account?.disableAutoProtection === true || account?.disableAutoProtection === 'true',
    snapshot: snapshot
      ? {
          userTokens: snapshot.userTokens,
          totalAllowance: snapshot.totalAllowance,
          orgOverageUsed: snapshot.orgOverageUsed,
          startDate: toIso(snapshot.startDate),
          fetchedAt: toIso(snapshot.fetchedAt)
        }
      : null,
    snapshotStale: stale === true,
    snapshotError: error || null,
    windows,
    usd: {
      usdPerMTokens: roundTo(ratio.usdPerMTokens, 4),
      ratioSource: ratio.source,
      weekly: roundTo((allowance * ratio.usdPerMTokens) / TOKENS_PER_M, 2),
      monthly: roundTo((thirtyCap.cap * ratio.usdPerMTokens) / TOKENS_PER_M, 2)
    },
    generatedAt: toIso(now)
  }
}

// ==================== 服务 ====================

class DroidUsageWindowService {
  constructor() {
    this._inflightSnapshots = new Map()
    this._provider = null
  }

  // 懒加载：避免模块加载时拉起 droidAccountService（构造函数里有 setInterval），也方便测试替换
  _getProvider() {
    if (!this._provider) {
      const DroidBalanceProvider = require('./balanceProviders/droidBalanceProvider')
      this._provider = new DroidBalanceProvider()
    }
    return this._provider
  }

  _client() {
    return redis.getClientSafe()
  }

  // ---------- 快照 ----------

  async _readCachedSnapshot(accountId) {
    try {
      return parseSnapshotRecord(await this._client().get(KEYS.snapshot(accountId)))
    } catch (error) {
      logger.debug(`读取 Droid 用量快照缓存失败: ${accountId}: ${error.message}`)
      return null
    }
  }

  /**
   * 获取 chat-usage 快照
   * - 默认读缓存（snapshotCacheSeconds 内视为新鲜）；force 时跳过缓存
   * - 进程内 singleflight：同一账号同时只有一个请求在飞
   * - 拉取失败时返回上次的快照并标记 stale 与 error
   * @returns {Promise<{snapshot: object|null, stale: boolean, error: string|null}>}
   */
  async getSnapshot(accountId, options = {}) {
    if (!accountId) {
      return { snapshot: null, stale: false, error: '缺少账号 ID' }
    }

    const now = Number(options.now) || Date.now()
    const settings = getSettings()

    if (!options.force) {
      const cached = await this._readCachedSnapshot(accountId)
      if (cached && now - cached.fetchedAt < settings.snapshotCacheSeconds * 1000) {
        return { snapshot: cached, stale: false, error: null }
      }
    }

    if (this._inflightSnapshots.has(accountId)) {
      return this._inflightSnapshots.get(accountId)
    }

    const promise = this._fetchSnapshot(accountId).finally(() => {
      this._inflightSnapshots.delete(accountId)
    })
    this._inflightSnapshots.set(accountId, promise)
    return promise
  }

  async _fetchSnapshot(accountId) {
    try {
      const result = await this._getProvider().queryBalance({ id: accountId })
      const snapshot = buildSnapshot(result?.rawData, Date.now())
      try {
        await this._client().set(
          KEYS.snapshot(accountId),
          JSON.stringify(snapshot),
          'EX',
          SNAPSHOT_RETENTION_SECONDS
        )
      } catch (error) {
        logger.warn(`⚠️ 写入 Droid 用量快照缓存失败: ${accountId}: ${error.message}`)
      }
      await this._updateWeekRecord(accountId, snapshot)
      return { snapshot, stale: false, error: null }
    } catch (error) {
      const message = error?.message || 'Factory 配额查询失败'
      logger.debug(`Droid 用量快照拉取失败: ${accountId}: ${message}`)
      const cached = await this._readCachedSnapshot(accountId)
      return { snapshot: cached, stale: !!cached, error: message }
    }
  }

  // ---------- 周记录 ----------

  async _updateWeekRecord(accountId, snapshot, options = {}) {
    if (!snapshot || !Number.isFinite(snapshot.startDate)) {
      return null
    }
    try {
      const client = this._client()
      const key = KEYS.week(accountId)
      const field = String(snapshot.startDate)
      const hash = (await client.hgetall(key)) || {}
      const existing = parseJson(hash[field]) || {}
      const now = Date.now()
      const record = {
        startDate: snapshot.startDate,
        endDate: snapshot.endDate ?? toNumberOrNull(existing.endDate),
        maxUserTokens: Math.max(Number(existing.maxUserTokens) || 0, snapshot.userTokens || 0),
        totalAllowance: snapshot.totalAllowance ?? existing.totalAllowance ?? null,
        capped: existing.capped === true || options.capped === true,
        lastSeenAt: now
      }
      await client.hset(key, field, JSON.stringify(record))

      // 整个 key 的 TTL 每次写入都会续期，旧周要自己删掉，否则活跃账号的周记录只增不减
      const cutoff = now - RECORD_TTL_SECONDS * 1000
      const staleFields = Object.keys(hash).filter((name) => {
        if (name === field) {
          return false
        }
        const week = parseJson(hash[name])
        const end = week ? weekEndOf({ ...week, startDate: Number(week.startDate) }) : null
        return end === null || end < cutoff
      })
      if (staleFields.length > 0) {
        await client.hdel(key, ...staleFields)
      }
      await client.expire(key, RECORD_TTL_SECONDS)
      return record
    } catch (error) {
      logger.warn(`⚠️ 更新 Droid 周用量记录失败: ${accountId}: ${error.message}`)
      return null
    }
  }

  async _loadWeekRecords(accountId) {
    try {
      return parseWeekHash(await this._client().hgetall(KEYS.week(accountId)))
    } catch (error) {
      logger.debug(`读取 Droid 周用量记录失败: ${accountId}: ${error.message}`)
      return []
    }
  }

  // ---------- 上限样本 ----------

  async _recordCapSample(kind, sample) {
    try {
      const client = this._client()
      const key = KEYS.capSamples(kind)
      await client.lpush(key, JSON.stringify(sample))
      await client.ltrim(key, 0, MAX_CAP_SAMPLES - 1)
      await client.expire(key, RECORD_TTL_SECONDS)
      logger.info(
        `📐 记录 Droid ${kind} 上限样本: ${Math.round(sample.capTokens)} tokens（账号 ${sample.accountId}）`
      )
      return true
    } catch (error) {
      logger.warn(`⚠️ 记录 Droid ${kind} 上限样本失败: ${error.message}`)
      return false
    }
  }

  /**
   * 同一次限额事件只采一个样本：并发的 402 各自读到「未采样」时，用 SET NX 决出唯一的采样者
   * @returns {Promise<boolean>} 是否拿到采样权；Redis 异常时返回 false（宁可少采）
   */
  async _claimCapSample(kind, accountId, eventId, ttlMs) {
    try {
      const result = await this._client().set(
        KEYS.capClaim(kind, accountId, eventId),
        '1',
        'PX',
        Math.max(1000, Math.ceil(ttlMs)),
        'NX'
      )
      return result === 'OK'
    } catch (error) {
      logger.debug(`Droid ${kind} 上限采样占位失败: ${accountId}: ${error.message}`)
      return false
    }
  }

  async _loadCapSamples(kind) {
    try {
      const list = await this._client().lrange(KEYS.capSamples(kind), 0, MAX_CAP_SAMPLES - 1)
      return (list || [])
        .map((raw) => parseJson(raw))
        .filter((sample) => sample && Number(sample.capTokens) > 0)
    } catch (error) {
      logger.debug(`读取 Droid ${kind} 上限样本失败: ${error.message}`)
      return []
    }
  }

  // ---------- 窗口跟踪 ----------

  async _readWindow(key) {
    return parseWindowRecord(await this._client().get(key))
  }

  // 只有窗口不存在（或已过期）时才开启新窗口，TTL 到窗口结束
  async _ensureWindow(key, start, durationMs, now, extra = {}) {
    const end = start + durationMs
    const ttlMs = Math.ceil(end - now)
    if (ttlMs <= 0) {
      return null
    }
    const record = { start, end, ...extra }
    const result = await this._client().set(key, JSON.stringify(record), 'PX', ttlMs, 'NX')
    return result === 'OK' ? record : null
  }

  /**
   * 转发成功（usage > 0）后调用，不阻塞响应
   * - 没有 5h / 30d 窗口时开启新窗口（起点为请求开始时间）
   * - 新开的 5h 窗口拉一次快照写入 baseline
   */
  async onRequestSucceeded(account, requestStartMs) {
    const accountId = account?.id
    if (!accountId) {
      return { fiveHour: null, thirtyDay: null, baseline: null }
    }

    const now = Date.now()
    const start = Number.isFinite(Number(requestStartMs)) ? Number(requestStartMs) : now

    const [fiveHour, thirtyDay] = await Promise.all([
      this._ensureWindow(KEYS.window5h(accountId), start, FIVE_HOUR_MS, now, {
        baselineTokens: null,
        baselineStartDate: null,
        baselineAt: null,
        capSampled: false
      }),
      this._ensureWindow(KEYS.window30d(accountId), start, THIRTY_DAY_MS, now, {
        capSampled: false
      })
    ])

    let baseline = null
    if (fiveHour) {
      logger.debug(
        `🪟 Droid 账号 ${account.name || accountId} 开启新的 5h 窗口，${formatResetTime(fiveHour.end)} 结束`
      )
      baseline = await this._captureBaseline(accountId, fiveHour)
    }
    if (thirtyDay) {
      logger.debug(
        `🪟 Droid 账号 ${account.name || accountId} 开启新的 30d 窗口，${formatResetTime(thirtyDay.end)} 结束`
      )
    }

    return { fiveHour, thirtyDay, baseline }
  }

  async _captureBaseline(accountId, windowRecord) {
    const { snapshot, stale, error } = await this.getSnapshot(accountId, { force: true })
    if (!snapshot || stale) {
      logger.debug(`Droid 5h baseline 快照不可用: ${accountId}: ${error || 'stale'}`)
      return null
    }

    const key = KEYS.window5h(accountId)
    const current = await this._readWindow(key)
    // 窗口已被 402 纠正或替换时不再写 baseline
    if (!current || current.start !== windowRecord.start || current.end !== windowRecord.end) {
      return null
    }
    if (Number.isFinite(current.baselineTokens)) {
      return current
    }

    const ttlMs = Math.ceil(current.end - Date.now())
    if (ttlMs <= 0) {
      return null
    }
    const updated = {
      ...current,
      baselineTokens: snapshot.userTokens || 0,
      baselineStartDate: snapshot.startDate,
      baselineAt: snapshot.fetchedAt
    }
    await this._client().set(key, JSON.stringify(updated), 'PX', ttlMs, 'XX')
    return updated
  }

  /**
   * 402 解析成限额后调用（限额记录已由调用方写入），不阻塞响应
   * - 5h：窗口纠正为 [resetAt-5h, resetAt]；有对齐的 baseline 时记一次上限样本
   * - 7d：用 startDate + 7d 细化 resetAt，该周标记为 capped
   * - 30d：窗口纠正为 [resetAt-30d, resetAt]，记一次上限样本
   */
  async onUsageLimit(account, limit) {
    const accountId = account?.id
    const resetAt = Number(limit?.resetAt)
    if (!accountId || !Number.isFinite(resetAt)) {
      return null
    }

    try {
      if (limit.window === 'fiveHour') {
        return await this._onFiveHourLimit(account, resetAt)
      }
      if (limit.window === 'sevenDay') {
        return await this._onSevenDayLimit(account, limit)
      }
      if (limit.window === 'thirtyDay') {
        return await this._onThirtyDayLimit(account, resetAt)
      }
    } catch (error) {
      logger.warn(`⚠️ 处理 Droid 限额窗口失败: ${accountId} (${limit.window}): ${error.message}`)
    }
    return null
  }

  async _onFiveHourLimit(account, resetAt) {
    const accountId = account.id
    const now = Date.now()
    const ttlMs = Math.ceil(resetAt - now)
    if (ttlMs <= 0) {
      return null
    }

    const key = KEYS.window5h(accountId)
    const newStart = resetAt - FIVE_HOUR_MS
    const previous = await this._readWindow(key)
    const overlaps = previous && previous.start < resetAt && newStart < previous.end
    const baselineAligned =
      overlaps &&
      Number.isFinite(previous.baselineTokens) &&
      Number.isFinite(previous.baselineAt) &&
      Math.abs(previous.baselineAt - newStart) <= BASELINE_ALIGN_TOLERANCE_MS
    // 以 baselineAt 标识这次限额事件：同一窗口的并发 402 读到的是同一个 baseline
    const shouldSample =
      baselineAligned &&
      !previous.capSampled &&
      (await this._claimCapSample('5h', accountId, previous.baselineAt, ttlMs))

    // baseline 只有和纠正后的窗口起点对得上才保留：对不上（例如上线时账号已在 Factory 窗口中间）
    // 的差值会偏小，展示时不如按本地费用估算
    const corrected = {
      start: newStart,
      end: resetAt,
      baselineTokens: baselineAligned ? previous.baselineTokens : null,
      baselineStartDate: baselineAligned ? previous.baselineStartDate : null,
      baselineAt: baselineAligned ? previous.baselineAt : null,
      // 对齐的窗口要么由本次采样，要么已经（或正在）被别的请求采样
      capSampled: Boolean(baselineAligned)
    }
    await this._client().set(key, JSON.stringify(corrected), 'PX', ttlMs)

    let sample = null
    if (shouldSample) {
      sample = await this._sampleFiveHourCap(account, corrected)
    }
    return { window: corrected, sample }
  }

  async _sampleFiveHourCap(account, windowRecord) {
    const { snapshot, stale } = await this.getSnapshot(account.id, { force: true })
    if (!snapshot || stale || snapshot.startDate !== windowRecord.baselineStartDate) {
      logger.debug(`Droid 5h 上限采样跳过（快照不可用或周已切换）: ${account.id}`)
      return null
    }
    const capTokens = (snapshot.userTokens || 0) - windowRecord.baselineTokens
    if (!(capTokens > 0)) {
      return null
    }
    const sample = {
      accountId: account.id,
      capTokens,
      totalAllowance: snapshot.totalAllowance,
      windowStart: windowRecord.start,
      recordedAt: Date.now()
    }
    await this._recordCapSample('5h', sample)
    return sample
  }

  async _onSevenDayLimit(account, limit) {
    const accountId = account.id
    const { snapshot } = await this.getSnapshot(accountId, { force: true })
    // 拉取失败时可以用旧快照：同一周内 startDate 不变
    if (!snapshot || !Number.isFinite(snapshot.startDate)) {
      return null
    }
    const now = Date.now()
    const refined = weekEndOf(snapshot)
    if (refined <= now) {
      return null
    }

    await this._updateWeekRecord(accountId, snapshot, { capped: true })

    // Factory 的 "resets in N days" 向下取整：真实重置时间在 [解析值 - 缓冲, 解析值 + 1 天) 之间
    const lower = limit.resetAt - RESET_BUFFER_MS - WEEK_REFINE_TOLERANCE_MS
    const upper = limit.resetAt + 24 * 3600 * 1000 + WEEK_REFINE_TOLERANCE_MS
    if (refined < lower || refined > upper) {
      logger.warn(
        `⚠️ Droid 账号 ${account.name || accountId} 周额度重置时间对不上：402 解析 ${formatResetTime(limit.resetAt)}，chat-usage ${formatResetTime(refined)}，保留 402 解析值`
      )
      return { refinedResetAt: null }
    }

    const recorded = await droidUsageLimitService.recordLimit(
      accountId,
      { window: 'sevenDay', resetAt: refined + RESET_BUFFER_MS, detail: limit.detail },
      { source: 'chat-usage' }
    )
    if (recorded) {
      logger.info(
        `🗓️ Droid 账号 ${account.name || accountId} 周额度重置时间细化为 ${formatResetTime(recorded.resetAt)}`
      )
    }
    return { refinedResetAt: recorded ? recorded.resetAt : null }
  }

  async _onThirtyDayLimit(account, resetAt) {
    const accountId = account.id
    const now = Date.now()
    const ttlMs = Math.ceil(resetAt - now)
    if (ttlMs <= 0) {
      return null
    }

    const key = KEYS.window30d(accountId)
    const previous = await this._readWindow(key)
    const alreadySampled =
      previous?.capSampled === true && Math.abs(previous.end - resetAt) <= 24 * 3600 * 1000
    const corrected = { start: resetAt - THIRTY_DAY_MS, end: resetAt, capSampled: true }
    await this._client().set(key, JSON.stringify(corrected), 'PX', ttlMs)

    // 30d 限额期间同一账号只采一次（占位保留到 resetAt）
    if (alreadySampled || !(await this._claimCapSample('30d', accountId, 'limit', ttlMs))) {
      return { window: corrected, sample: null }
    }

    const { snapshot, stale } = await this.getSnapshot(accountId, { force: true })
    if (!snapshot || stale) {
      return { window: corrected, sample: null }
    }
    const weeks = await this._loadWeekRecords(accountId)
    const { tokens, weeksCounted } = sumWeekTokens({
      weeks,
      snapshot,
      since: corrected.start,
      now
    })
    if (weeksCounted === 0 || !(tokens > 0)) {
      return { window: corrected, sample: null }
    }
    const sample = {
      accountId,
      capTokens: tokens,
      totalAllowance: snapshot.totalAllowance,
      windowStart: corrected.start,
      recordedAt: now
    }
    await this._recordCapSample('30d', sample)
    return { window: corrected, sample }
  }

  // ---------- 批量展示 ----------

  async _loadAccounts(accountIds) {
    if (!Array.isArray(accountIds)) {
      const all = await redis.getAllDroidAccounts()
      return all.map((item) => ({
        id: item.id,
        name: item.name,
        disableAutoProtection: item.disableAutoProtection
      }))
    }

    const unique = [...new Set(accountIds.filter(Boolean))]
    const loaded = await Promise.all(
      unique.map(async (accountId) => {
        const data = await redis.getDroidAccount(accountId)
        if (!data || Object.keys(data).length === 0) {
          return null
        }
        return {
          id: accountId,
          name: data.name,
          disableAutoProtection: data.disableAutoProtection
        }
      })
    )
    return loaded.filter(Boolean)
  }

  async _loadAccountState(accountId, now) {
    const pipeline = this._client().pipeline()
    pipeline.get(KEYS.window5h(accountId))
    pipeline.get(KEYS.window30d(accountId))
    pipeline.hgetall(KEYS.week(accountId))
    const [results, limits] = await Promise.all([
      pipeline.exec(),
      droidUsageLimitService.getActiveLimits(accountId, { now })
    ])
    const valueAt = (index) => {
      const [err, value] = results[index] || []
      return err ? null : value
    }
    return {
      window5h: parseWindowRecord(valueAt(0)),
      window30d: parseWindowRecord(valueAt(1)),
      weeks: parseWeekHash(valueAt(2)),
      limits
    }
  }

  /**
   * 批量获取账号的三窗口数据（管理页用）
   * @param {string[]|null} accountIds - 为空时取全部 Droid 账号
   * @param {{force?: boolean}} options - force 时跳过快照缓存
   * @returns {Promise<Object<string, object>>} accountId -> windows
   */
  async getUsageWindows(accountIds = null, options = {}) {
    const force = options.force === true
    const settings = getSettings()
    const accounts = await this._loadAccounts(accountIds)
    if (accounts.length === 0) {
      return {}
    }

    const snapshotResults = await mapWithConcurrency(accounts, SNAPSHOT_CONCURRENCY, (account) =>
      this.getSnapshot(account.id, { force })
    )

    const now = Date.now()
    const [fiveHourSamples, thirtyDaySamples] = await Promise.all([
      this._loadCapSamples('5h'),
      this._loadCapSamples('30d')
    ])
    const capSamples = { fiveHour: fiveHourSamples, thirtyDay: thirtyDaySamples }

    const entries = await Promise.all(
      accounts.map(async (account, index) => {
        const snapshotResult = snapshotResults[index]
        try {
          const state = await this._loadAccountState(account.id, now)
          const sinces = planCostSinces({
            snapshot: snapshotResult.snapshot,
            stale: snapshotResult.stale,
            window5h: state.window5h,
            window30d: state.window30d,
            weeks: state.weeks,
            now
          })
          const sinceKeys = Object.keys(sinces)
          const values =
            sinceKeys.length > 0
              ? await redis.getAccountLocalCostsSince(
                  account.id,
                  sinceKeys.map((sinceKey) => sinces[sinceKey]),
                  { now }
                )
              : []
          const costs = {}
          sinceKeys.forEach((sinceKey, costIndex) => {
            costs[sinceKey] = Number(values[costIndex]) || 0
          })
          return { account, snapshotResult, ...state, costs }
        } catch (error) {
          logger.warn(`⚠️ 读取 Droid 额度窗口数据失败: ${account.id}: ${error.message}`)
          return { account, snapshotResult, failed: error.message }
        }
      })
    )

    const poolRatio = computePoolRatio(
      entries.filter((entry) => !entry.failed),
      now
    )

    const data = {}
    for (const entry of entries) {
      if (entry.failed) {
        data[entry.account.id] = { accountId: entry.account.id, error: entry.failed }
        continue
      }
      try {
        data[entry.account.id] = computeAccountWindows({
          ...entry,
          capSamples,
          poolRatio,
          settings,
          now
        })
      } catch (error) {
        logger.warn(`⚠️ 计算 Droid 额度窗口失败: ${entry.account.id}: ${error.message}`)
        data[entry.account.id] = { accountId: entry.account.id, error: error.message }
      }
    }
    return data
  }
}

const droidUsageWindowService = new DroidUsageWindowService()

// 纯函数与常量，供测试和调用方使用
Object.assign(droidUsageWindowService, {
  KEYS,
  DEFAULT_SETTINGS,
  DEFAULT_TOTAL_ALLOWANCE,
  MIN_FIVE_HOUR_SAMPLES,
  getSettings,
  buildSnapshot,
  parseWindowRecord,
  parseWeekHash,
  capFromSamples,
  sumWeekTokens,
  planCostSinces,
  resolveRatio,
  computePoolRatio,
  computeAccountWindows
})

module.exports = droidUsageWindowService
