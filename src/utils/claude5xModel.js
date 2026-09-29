/**
 * Claude 5.x（Sonnet/Opus/Haiku/Fable 5 及 5.x 变体）。
 * Factory 对这些模型拒绝 temperature / top_p。
 */
function isClaude5xModel(model) {
  if (typeof model !== 'string') {
    return false
  }

  return /^claude-(sonnet|opus|haiku|fable)-5([.-]|$)/i.test(model.trim())
}

module.exports = {
  isClaude5xModel
}
