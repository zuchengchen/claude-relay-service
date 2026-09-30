const droidAccountService = require('../account/droidAccountService')
const accountGroupService = require('../accountGroupService')
const droidUsageLimitService = require('../droidUsageLimitService')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const { formatResetTime } = require('../../utils/factoryUsageLimit')
const {
  isTruthy,
  isAccountHealthy,
  sortAccountsByPriority,
  normalizeEndpointType
} = require('../../utils/commonHelper')

/**
 * 所有候选账号都只因临时原因（额度用尽 / temp_unavailable）被排除
 * resetAt 取最早恢复时间，转发层据此返回 429 + 重置头
 */
class DroidAccountsExhaustedError extends Error {
  constructor(resetAt, exclusions = []) {
    super(`All Droid accounts are temporarily unavailable until ${new Date(resetAt).toISOString()}`)
    this.name = 'DroidAccountsExhaustedError'
    this.code = 'DROID_ACCOUNTS_EXHAUSTED'
    this.resetAt = resetAt
    this.exclusions = exclusions
  }
}

class DroidScheduler {
  constructor() {
    this.STICKY_PREFIX = 'droid'
  }

  _isAccountSchedulable(account) {
    return isTruthy(account?.schedulable ?? true)
  }

  _matchesEndpoint(account, endpointType) {
    const normalizedEndpoint = normalizeEndpointType(endpointType)
    const accountEndpoint = normalizeEndpointType(account?.endpointType)
    if (normalizedEndpoint === accountEndpoint) {
      return true
    }
    if (normalizedEndpoint === 'comm') {
      return true
    }
    const sharedEndpoints = new Set(['anthropic', 'openai'])
    return sharedEndpoints.has(normalizedEndpoint) && sharedEndpoints.has(accountEndpoint)
  }

  _composeStickySessionKey(endpointType, sessionHash, apiKeyId) {
    if (!sessionHash) {
      return null
    }
    const normalizedEndpoint = normalizeEndpointType(endpointType)
    const apiKeyPart = apiKeyId || 'default'
    return `${this.STICKY_PREFIX}:${normalizedEndpoint}:${apiKeyPart}:${sessionHash}`
  }

  // 健康、可调度且 endpoint 匹配：只有这样的账号的恢复时间才对本次请求有意义
  _isUsableFor(account, normalizedEndpoint) {
    return (
      !!account &&
      isAccountHealthy(account) &&
      this._isAccountSchedulable(account) &&
      this._matchesEndpoint(account, normalizedEndpoint)
    )
  }

  // 额度用尽 / temp_unavailable 判定；exclusions 为数组时记录被排除的账号，用于计算最早恢复时间
  async _checkBlock(account, exclusions, label) {
    const block = await droidUsageLimitService.getSchedulingBlock(account)
    if (!block.blocked) {
      return block
    }

    if (Array.isArray(exclusions)) {
      exclusions.push({ accountId: account.id, until: block.until, reason: block.reason })
    }
    const detail =
      block.reason === 'usage_limit'
        ? `额度用尽（${block.limits.map((item) => item.window).join(', ')}），${formatResetTime(block.until)} 恢复`
        : `temporarily unavailable，${formatResetTime(block.until)} 恢复`
    logger.debug(`⏭️ Skipping Droid ${label} ${account.name || account.id} - ${detail}`)
    return block
  }

  async _loadGroupAccounts(groupId, normalizedEndpoint, exclusions = []) {
    const memberIds = await accountGroupService.getGroupMembers(groupId)
    if (!memberIds || memberIds.length === 0) {
      return []
    }

    const accounts = await Promise.all(
      memberIds.map(async (memberId) => {
        try {
          return await droidAccountService.getAccount(memberId)
        } catch (error) {
          logger.warn(`⚠️ 获取 Droid 分组成员账号失败: ${memberId}`, error)
          return null
        }
      })
    )

    const result = []
    for (const account of accounts) {
      if (!account || !isAccountHealthy(account) || !this._isAccountSchedulable(account)) {
        continue
      }
      // endpoint 不匹配的成员照旧留给后面的过滤处理，但它的恢复时间不计入 exclusions
      const block = await this._checkBlock(
        account,
        this._matchesEndpoint(account, normalizedEndpoint) ? exclusions : null,
        'group member'
      )
      if (block.blocked) {
        continue
      }
      result.push(account)
    }
    return result
  }

  // 同一账号可能在分组和号池里各被判定一次，按账号去重后取最早恢复时间
  _buildExhaustedError(exclusions) {
    const byAccount = new Map()
    for (const item of exclusions) {
      if (Number.isFinite(item?.until)) {
        byAccount.set(item.accountId, item)
      }
    }
    const temporal = [...byAccount.values()]
    if (temporal.length === 0) {
      return null
    }
    const resetAt = Math.min(...temporal.map((item) => item.until))
    return new DroidAccountsExhaustedError(resetAt, temporal)
  }

  async _ensureLastUsedUpdated(accountId) {
    try {
      await droidAccountService.touchLastUsedAt(accountId)
    } catch (error) {
      logger.warn(`⚠️ 更新 Droid 账号最后使用时间失败: ${accountId}`, error)
    }
  }

  async _cleanupStickyMapping(stickyKey) {
    if (!stickyKey) {
      return
    }
    try {
      await redis.deleteSessionAccountMapping(stickyKey)
    } catch (error) {
      logger.warn(`⚠️ 清理 Droid 粘性会话映射失败: ${stickyKey}`, error)
    }
  }

  async selectAccount(apiKeyData, endpointType, sessionHash) {
    const normalizedEndpoint = normalizeEndpointType(endpointType)
    const stickyKey = this._composeStickySessionKey(normalizedEndpoint, sessionHash, apiKeyData?.id)

    let candidates = []
    let isDedicatedBinding = false
    // 只收集因临时原因（额度用尽 / temp_unavailable）被排除的账号；
    // 不健康、不可调度、endpoint 不匹配的账号不参与最早恢复时间的计算
    const exclusions = []

    if (apiKeyData?.droidAccountId) {
      const binding = apiKeyData.droidAccountId
      if (binding.startsWith('group:')) {
        const groupId = binding.substring('group:'.length)
        logger.info(
          `🤖 API Key ${apiKeyData.name || apiKeyData.id} 绑定 Droid 分组 ${groupId}，按分组调度`
        )
        candidates = await this._loadGroupAccounts(groupId, normalizedEndpoint, exclusions)
      } else {
        const account = await droidAccountService.getAccount(binding)
        if (account) {
          // 与原逻辑一致：只有临时不可用才回退号池；本身不可用的绑定账号不计入恢复时间
          const block = await this._checkBlock(
            account,
            this._isUsableFor(account, normalizedEndpoint) ? exclusions : null,
            'bound account'
          )
          if (block.blocked) {
            logger.warn(
              `⏱️ Bound Droid account ${account.name || account.id} unavailable (${block.reason}) until ${formatResetTime(block.until)}, falling back to pool`
            )
          } else {
            candidates = [account]
            isDedicatedBinding = true
          }
        }
      }
    }

    if (!candidates || candidates.length === 0) {
      candidates = await droidAccountService.getSchedulableAccounts(normalizedEndpoint)
    }

    const syncFiltered = candidates.filter((account) =>
      this._isUsableFor(account, normalizedEndpoint)
    )
    const filteredResults = await Promise.all(
      syncFiltered.map(async (account) => {
        const block = await this._checkBlock(account, exclusions, 'account')
        return block.blocked ? null : account
      })
    )
    const filtered = filteredResults.filter(Boolean)

    if (filtered.length === 0) {
      const exhausted = this._buildExhaustedError(exclusions)
      if (exhausted) {
        logger.warn(
          `⏳ 所有 Droid 候选账号暂不可用（${exhausted.exclusions.length} 个因额度用尽或临时暂停被排除），最早 ${formatResetTime(exhausted.resetAt)} 恢复`
        )
        throw exhausted
      }
      throw new Error(
        `No available accounts for endpoint ${normalizedEndpoint}${apiKeyData?.droidAccountId ? ' (respecting binding)' : ''}`
      )
    }

    if (stickyKey && !isDedicatedBinding) {
      const mappedAccountId = await redis.getSessionAccountMapping(stickyKey)
      if (mappedAccountId) {
        const mappedAccount = filtered.find((account) => account.id === mappedAccountId)
        if (mappedAccount) {
          await redis.extendSessionAccountMappingTTL(stickyKey)
          logger.info(
            `🤖 命中 Droid 粘性会话: ${sessionHash} -> ${mappedAccount.name || mappedAccount.id}`
          )
          await this._ensureLastUsedUpdated(mappedAccount.id)
          return mappedAccount
        }

        await this._cleanupStickyMapping(stickyKey)
      }
    }

    const sorted = sortAccountsByPriority(filtered)
    const selected = sorted[0]

    if (!selected) {
      throw new Error(`No schedulable account available after sorting (${normalizedEndpoint})`)
    }

    if (stickyKey && !isDedicatedBinding) {
      await redis.setSessionAccountMapping(stickyKey, selected.id)
    }

    await this._ensureLastUsedUpdated(selected.id)

    logger.info(
      `🤖 选择 Droid 账号 ${selected.name || selected.id}（endpoint: ${normalizedEndpoint}, priority: ${selected.priority || 50}）`
    )

    return selected
  }
}

const droidScheduler = new DroidScheduler()
droidScheduler.DroidAccountsExhaustedError = DroidAccountsExhaustedError

module.exports = droidScheduler
