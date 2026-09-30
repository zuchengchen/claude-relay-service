/**
 * 配置存根：Droid sidecar 不再使用 Claude Relay 专属配置。
 */
class ClaudeRelayConfigService {
  async getConfig() {
    return {}
  }

  async isClaudeCodeOnlyEnabled() {
    return false
  }
}

module.exports = new ClaudeRelayConfigService()
