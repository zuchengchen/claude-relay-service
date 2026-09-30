const redis = require('../models/redis')
const logger = require('../utils/logger')
const {
  getTempUnavailableKey,
  interpretTempUnavailableTtl
} = require('../utils/upstreamErrorHelper')
const { USAGE_WINDOWS } = require('../utils/factoryUsageLimit')

/**
 * Droid（Factory）额度限额记录
 *
 * - 402 解析成限额后写入 `droid:usage_limit:{accountId}:{window}`，TTL 到 resetAt，过期自动消失
 * - 调度器通过 getSchedulingBlock 判断账号是否需要在 resetAt 之前避开
 * - 「重置状态」调用 clearLimits 立即恢复调度
 */

const USAGE_LIMIT_PREFIX = 'droid:usage_limit'

const limitKey = (accountId, window) => `${USAGE_LIMIT_PREFIX}:${accountId}:${window}`

const isAutoProtectionDisabled = (account) =>
  account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'

const parseLimitValue = (raw) => {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    const resetAt = Number(parsed?.resetAt)
    if (!Number.isFinite(resetAt)) {
      return null
    }
    return { ...parsed, resetAt }
  } catch {
    return null
  }
}

const notBlocked = () => ({ blocked: false, until: null, reason: null, limits: [] })

class DroidUsageLimitService {
  /**
   * 记录一个窗口的限额
   * @returns {Promise<object|null>} 写入的记录；已过期或写入失败时返回 null
   */
  async recordLimit(accountId, limit, options = {}) {
    const window = limit?.window
    const resetAt = Number(limit?.resetAt)
    if (!accountId || !USAGE_WINDOWS.includes(window) || !Number.isFinite(resetAt)) {
      return null
    }

    const now = Number(options.now) || Date.now()
    const ttlMs = Math.ceil(resetAt - now)
    if (ttlMs <= 0) {
      return null
    }

    const record = {
      resetAt,
      detail: typeof limit.detail === 'string' ? limit.detail.slice(0, 500) : '',
      source: options.source || '402',
      recordedAt: now
    }

    try {
      const client = redis.getClientSafe()
      await client.set(limitKey(accountId, window), JSON.stringify(record), 'PX', ttlMs)
      return { window, ...record }
    } catch (error) {
      logger.error(`❌ 写入 Droid 限额记录失败: ${accountId} (${window})`, error)
      return null
    }
  }

  /**
   * 当前生效的限额，形如 { fiveHour: {resetAt, detail, source, recordedAt}, ... }
   */
  async getActiveLimits(accountId, options = {}) {
    if (!accountId) {
      return {}
    }

    const now = Number(options.now) || Date.now()
    try {
      const client = redis.getClientSafe()
      const pipeline = client.pipeline()
      USAGE_WINDOWS.forEach((window) => pipeline.get(limitKey(accountId, window)))
      const results = await pipeline.exec()

      const limits = {}
      USAGE_WINDOWS.forEach((window, index) => {
        const [err, raw] = results[index] || []
        const parsed = err ? null : parseLimitValue(raw)
        if (parsed && parsed.resetAt > now) {
          limits[window] = parsed
        }
      })
      return limits
    } catch (error) {
      logger.warn(`⚠️ 读取 Droid 限额记录失败: ${accountId}: ${error.message}`)
      return {}
    }
  }

  async clearLimits(accountId) {
    if (!accountId) {
      return 0
    }
    try {
      const client = redis.getClientSafe()
      const removed = await client.del(
        ...USAGE_WINDOWS.map((window) => limitKey(accountId, window))
      )
      if (removed > 0) {
        logger.info(`🧹 已清除 Droid 账号 ${accountId} 的 ${removed} 条限额记录`)
      }
      return removed
    } catch (error) {
      logger.error(`❌ 清除 Droid 限额记录失败: ${accountId}`, error)
      return 0
    }
  }

  /**
   * 调度判定：temp_unavailable 与限额记录
   * - temp_unavailable 的 until = now + 剩余 TTL
   * - 限额的 until 取所有生效窗口里最晚的 resetAt
   * - 账号勾选「禁用自动保护」时忽略限额（temp_unavailable 仍然生效，与原逻辑一致）
   * - Redis 异常时放行（与 isTempUnavailable 的失败策略一致）
   * @returns {Promise<{blocked: boolean, until: number|null, reason: 'usage_limit'|'temp_unavailable'|null, limits: Array}>}
   */
  async getSchedulingBlock(account, options = {}) {
    const accountId = account?.id
    if (!accountId) {
      return notBlocked()
    }

    const now = Number(options.now) || Date.now()

    try {
      const client = redis.getClientSafe()
      const pipeline = client.pipeline()
      pipeline.pttl(getTempUnavailableKey(accountId, 'droid'))
      USAGE_WINDOWS.forEach((window) => pipeline.get(limitKey(accountId, window)))
      const results = await pipeline.exec()

      // temp_unavailable 的判定规则（含无 TTL 自愈）与 isTempUnavailable 共用
      let tempUntil = null
      const [tempErr, tempTtl] = results[0] || []
      if (
        !tempErr &&
        interpretTempUnavailableTtl(tempTtl, { client, accountId, accountType: 'droid' })
      ) {
        tempUntil = now + tempTtl
      }

      const limits = []
      if (!isAutoProtectionDisabled(account)) {
        USAGE_WINDOWS.forEach((window, index) => {
          const [err, raw] = results[index + 1] || []
          const parsed = err ? null : parseLimitValue(raw)
          if (parsed && parsed.resetAt > now) {
            limits.push({ window, resetAt: parsed.resetAt })
          }
        })
      }

      if (limits.length > 0) {
        const limitUntil = Math.max(...limits.map((item) => item.resetAt))
        return {
          blocked: true,
          until: tempUntil ? Math.max(limitUntil, tempUntil) : limitUntil,
          reason: 'usage_limit',
          limits
        }
      }

      if (tempUntil) {
        return { blocked: true, until: tempUntil, reason: 'temp_unavailable', limits }
      }

      return notBlocked()
    } catch (error) {
      logger.error(`❌ 检查 Droid 账号调度状态失败: ${accountId}`, error)
      return notBlocked()
    }
  }
}

const droidUsageLimitService = new DroidUsageLimitService()
droidUsageLimitService.USAGE_LIMIT_PREFIX = USAGE_LIMIT_PREFIX
droidUsageLimitService.limitKey = limitKey

module.exports = droidUsageLimitService
