const BaseBalanceProvider = require('./baseBalanceProvider')
const droidAccountService = require('../account/droidAccountService')

// 非官方接口（开源工具 droid-switch 的用法），返回当前组织成员的 token 配额与用量
const FACTORY_CHAT_USAGE_URL = 'https://app.factory.ai/api/organization/members/chat-usage'
const DEFAULT_USER_AGENT = 'factory-cli/0.229.0'
const CREDENTIAL_INVALID_MESSAGE = 'Factory 凭证无效或已过期（下次转发会自动刷新）'

// null/undefined/'' 视为缺失，避免 Number(null) === 0 把"没有字段"当成 0
const toFiniteNumber = (value) => {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

// Factory 返回的日期是毫秒时间戳（实测 usage.startDate），缺失时为 null
const toIsoOrNull = (value) => {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const numeric = toFiniteNumber(value)
  const date = new Date(numeric !== null ? numeric : value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * Droid (Factory.ai) 配额 Provider
 *
 * 通过 chat-usage 接口查询 Factory 的 token 配额（单位是 token，不是美元）：
 * - balance 恒为 null，数据放在 quota 里（type = 'factory_tokens'）
 * - 只读取当前存储的凭证，不调用 getValidAccessToken / refreshAccessToken：
 *   refreshAccessToken 没有并发锁，WorkOS refresh token 会轮换，
 *   与转发同时刷新可能把账户打成 error。凭证过期时抛错，等下一次转发自动刷新。
 */
class DroidBalanceProvider extends BaseBalanceProvider {
  constructor() {
    super('droid')
  }

  async queryBalance(account) {
    const accountId = account?.id
    if (!accountId) {
      throw new Error('账户数据异常：缺少 id')
    }

    // 批量路径传入的是 getAllAccounts() 结果，accessToken 已打码，必须重新取解密后的账户
    const fresh = await droidAccountService.getAccount(accountId)
    if (!fresh) {
      throw new Error('账户不存在')
    }

    const credential = await this._resolveCredential(fresh)
    if (!credential) {
      throw new Error('缺少可用凭证')
    }

    const response = await this.makeRequest(
      FACTORY_CHAT_USAGE_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          'x-factory-client': 'cli',
          Accept: 'application/json',
          'User-Agent': this._resolveUserAgent(fresh)
        },
        timeout: 15000
      },
      { proxy: fresh.proxy }
    )

    // makeRequest 失败时不抛异常，只返回 { success: false }，这里需要自己抛
    if (!response.success) {
      const { status } = response
      if (status === 401 || status === 403) {
        throw new Error(CREDENTIAL_INVALID_MESSAGE)
      }
      const detail = this._redact(response.error || '请求失败', credential)
      throw new Error(`Factory 配额查询失败: ${status ? `HTTP ${status} ` : ''}${detail}`)
    }

    const usage = response.data?.usage
    if (!usage || typeof usage !== 'object' || !usage.standard) {
      throw new Error('Factory 配额响应格式无法识别')
    }

    return {
      balance: null,
      currency: 'USD',
      queryMethod: 'api',
      quota: this._mapQuota(usage),
      rawData: usage
    }
  }

  async _resolveCredential(account) {
    const authMethod =
      typeof account.authenticationMethod === 'string'
        ? account.authenticationMethod.toLowerCase().trim()
        : ''

    if (authMethod === 'api_key') {
      const entries = await droidAccountService.getDecryptedApiKeyEntries(account.id)
      const active = (entries || []).find((entry) => entry && entry.key && entry.status !== 'error')
      return active ? active.key : null
    }

    return account.accessToken || null
  }

  // 与 droidRelayService._buildHeaders 保持一致：账户自定义 UA 优先，其次转发服务默认 UA
  _resolveUserAgent(account) {
    const custom = typeof account?.userAgent === 'string' ? account.userAgent.trim() : ''
    if (custom) {
      return custom
    }

    try {
      // 懒加载：避免模块加载时拉起转发服务及其依赖，也方便测试 mock
      const droidRelayService = require('../relay/droidRelayService')
      return droidRelayService?.userAgent || DEFAULT_USER_AGENT
    } catch (error) {
      return DEFAULT_USER_AGENT
    }
  }

  _mapQuota(usage) {
    const { standard } = usage
    const total = toFiniteNumber(standard.totalAllowance) ?? 0
    const used = toFiniteNumber(standard.userTokens) ?? 0
    const ratio = toFiniteNumber(standard.usedRatio)

    let percentage = 0
    if (total > 0) {
      const raw = ratio !== null ? ratio * 100 : (used / total) * 100
      percentage = Math.round(raw * 100) / 100
    }

    return {
      type: 'factory_tokens',
      total,
      used,
      remaining: Math.max(0, total - used),
      percentage,
      overage: toFiniteNumber(standard.orgOverageUsed) ?? 0,
      resetAt: toIsoOrNull(usage.endDate)
    }
  }

  // 防御：上游错误信息理论上不含凭证，这里仍然兜底去掉
  _redact(message, secret) {
    const text = String(message || '')
    if (!secret || secret.length < 8) {
      return text
    }
    return text.split(secret).join('***')
  }
}

module.exports = DroidBalanceProvider
