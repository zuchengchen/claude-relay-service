/**
 * 限流状态自动清理服务（Droid sidecar：Factory 冷却由 upstreamErrorHelper 处理）
 */

const logger = require('../utils/logger')

class RateLimitCleanupService {
  constructor() {
    this.cleanupInterval = null
    this.isRunning = false
  }

  start(intervalMinutes = 5) {
    logger.info(
      `🧹 Rate limit cleanup skipped on Droid sidecar (interval config ${intervalMinutes}m unused)`
    )
  }

  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.isRunning = false
  }

  async performCleanup() {
    return { checked: 0, cleared: 0 }
  }
}

module.exports = new RateLimitCleanupService()
