<template>
  <div v-if="!usage" class="text-xs text-gray-400 dark:text-gray-500">
    <i class="fas fa-spinner fa-spin mr-1" />加载额度窗口...
  </div>
  <div v-else-if="usage.error && !usage.windows" class="text-xs text-amber-600 dark:text-amber-400">
    额度窗口加载失败：{{ usage.error }}
  </div>
  <div v-else class="space-y-1">
    <div
      v-for="row in rows"
      :key="row.key"
      class="flex items-center gap-1"
      :data-testid="`droid-usage-${row.key}`"
      :title="row.title"
    >
      <span
        :class="[
          'w-[30px] shrink-0 rounded px-1 text-center text-[10px] font-medium',
          row.labelClass
        ]"
      >
        {{ row.label }}
      </span>
      <div class="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div
          :class="['h-full transition-all duration-300', row.barClass]"
          :style="{ width: row.barWidth }"
        />
      </div>
      <span
        :class="[
          'w-[40px] shrink-0 text-right text-[10px] font-medium tabular-nums',
          row.textClass
        ]"
      >
        {{ row.percentText }}
      </span>
      <span class="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-gray-500">
        {{ row.countdown }}
      </span>
    </div>

    <div class="flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400">
      <span class="tabular-nums">{{ footerText }}</span>
      <el-tooltip placement="top" :show-after="200">
        <template #content>
          <div class="w-[300px] space-y-1.5 text-xs leading-relaxed">
            <div v-for="(line, index) in tooltipLines" :key="index">{{ line }}</div>
          </div>
        </template>
        <i
          class="fas fa-question-circle cursor-help text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
        />
      </el-tooltip>
    </div>

    <div
      v-if="snapshotWarning"
      class="max-w-[220px] truncate text-[10px] text-amber-600 dark:text-amber-400"
      :title="snapshotWarning"
    >
      <i class="fas fa-exclamation-triangle mr-0.5" />{{ snapshotWarning }}
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  // 后端 GET /admin/droid-accounts/usage-windows 返回的单账号数据
  usage: { type: Object, default: null },
  // 父组件每秒更新的时间戳，倒计时在本地递减
  nowTs: { type: Number, default: () => Date.now() }
})

const WINDOWS = [
  {
    key: 'fiveHour',
    label: '5h',
    labelClass: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
  },
  {
    key: 'sevenDay',
    label: '7d',
    labelClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
  },
  {
    key: 'thirtyDay',
    label: '30d',
    labelClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
  }
]

const SOURCE_TEXT = {
  'chat-usage': 'Factory chat-usage 实测',
  baseline: '开窗 baseline 与当前 userTokens 的差值',
  local: '本地 relay 费用 ÷ 比率 估算',
  weeks: '按 Factory 周汇总',
  idle: '窗口未开启'
}

const toMillions = (value) => {
  const num = Number(value) || 0
  return `${(num / 1e6).toFixed(num >= 1e8 ? 0 : 2)}M`
}

const formatCountdown = (resetAt, util) => {
  if (!resetAt) return '-'
  const diffMs = new Date(resetAt).getTime() - props.nowTs
  if (!Number.isFinite(diffMs)) return '-'
  if (diffMs <= 0) return util > 0 ? '待刷新' : '现在'

  const totalMinutes = Math.floor(diffMs / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours >= 1) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

const colorFor = (win) => {
  const util = Number(win?.util) || 0
  if (win?.limited || util >= 90) {
    return { bar: 'bg-red-500', text: 'text-red-600 dark:text-red-400' }
  }
  if (util >= 75) {
    return { bar: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' }
  }
  return { bar: 'bg-green-500', text: 'text-gray-600 dark:text-gray-400' }
}

const percentTextFor = (win) => {
  if (win?.limited) return '限额'
  const percent = Math.round(Number(win?.util) || 0)
  const text = percent > 999 ? '>999%' : `${percent}%`
  return win?.estimated ? `≈${text}` : text
}

const titleFor = (meta, win) => {
  const lines = [
    `${meta.label}：${toMillions(win.used)} / ${toMillions(win.cap)} Factory token`,
    `用量来源：${SOURCE_TEXT[win.source] || win.source || '-'}`
  ]
  if (meta.key !== 'sevenDay') {
    lines.push(
      `上限来源：${win.capSource === 'samples' ? `${win.capSampleCount} 个 402 样本的中位数` : win.capSource === 'config' ? '配置值' : '默认估算'}`
    )
  }
  if (win.resetAt) {
    lines.push(`重置时间：${new Date(win.resetAt).toLocaleString()}`)
  }
  if (win.limited && win.limitDetail) {
    lines.push(`Factory：${win.limitDetail}`)
  }
  return lines.join('\n')
}

const rows = computed(() => {
  const windows = props.usage?.windows || {}
  return WINDOWS.filter((meta) => windows[meta.key]).map((meta) => {
    const win = windows[meta.key]
    const color = colorFor(win)
    const util = Number(win.util) || 0
    return {
      key: meta.key,
      label: meta.label,
      labelClass: meta.labelClass,
      barClass: color.bar,
      textClass: color.text,
      barWidth: `${win.limited ? 100 : Math.min(Math.max(util, 0), 100)}%`,
      percentText: percentTextFor(win),
      countdown: formatCountdown(win.resetAt, util),
      title: titleFor(meta, win)
    }
  })
})

const footerText = computed(() => {
  const usd = props.usage?.usd
  if (!usd) return ''
  const weekly = Math.round(Number(usd.weekly) || 0)
  const monthly = Math.round(Number(usd.monthly) || 0)
  const ratio = (Number(usd.usdPerMTokens) || 0).toFixed(2)
  return `周 ≈$${weekly} · 月 ≈$${monthly} · $${ratio}/M`
})

const formatAge = (iso) => {
  if (!iso) return ''
  const seconds = Math.max(0, Math.floor((props.nowTs - new Date(iso).getTime()) / 1000))
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86400)} 天前`
}

const snapshotWarning = computed(() => {
  const error = props.usage?.snapshotError
  if (!error) return ''
  if (props.usage?.snapshot && props.usage?.snapshotStale) {
    return `快照拉取失败，显示 ${formatAge(props.usage.snapshot.fetchedAt)} 的数据：${error}`
  }
  return `${error}（已改用本地估算）`
})

const tooltipLines = computed(() => {
  const usage = props.usage || {}
  const windows = usage.windows || {}
  const usd = usage.usd || {}
  const five = windows.fiveHour || {}
  const thirty = windows.thirtyDay || {}

  // 比例和样本门槛由后端返回（可配置）；旧后端没有这两个字段时不显示具体数值
  const fiveRatioText = Number.isFinite(five.capRatio)
    ? `${Math.round(five.capRatio * 1000) / 10}%`
    : '配置比例'
  const fiveMinSamples = Number.isFinite(five.capMinSamples) ? five.capMinSamples : null
  const fiveCap =
    five.capSource === 'samples'
      ? `${five.capSampleCount} 个 402 上限样本的中位数`
      : `周额度 × ${fiveRatioText}（默认值，已有 ${five.capSampleCount || 0} 个样本${fiveMinSamples ? `，满 ${fiveMinSamples} 个后改用中位数` : ''}）`
  const thirtyCap =
    thirty.capSource === 'config'
      ? '配置值'
      : thirty.capSource === 'samples'
        ? `${thirty.capSampleCount} 个 30d 限额样本的中位数`
        : '周额度 × 30/7（推测）'
  const ratioSource =
    usd.ratioSource === 'account'
      ? '本账号本周 relay 费用 ÷ Factory userTokens'
      : usd.ratioSource === 'pool'
        ? '号池加权平均（本账号本周用量不足 2M）'
        : '配置默认值'
  const snapshotAge = usage.snapshot?.fetchedAt
    ? `快照拉取于 ${formatAge(usage.snapshot.fetchedAt)}`
    : '暂无 Factory 快照'

  const lines = [
    '7d 是 Factory chat-usage 的精确值；带 ≈ 的 5h、30d 是估算值。',
    `5h 窗口从第一次成功转发开始计时，收到 402 后按 Factory 给出的重置时间纠正。上限：${fiveCap}。`,
    `30d 用量按 Factory 周汇总，上限：${thirtyCap}。30d 上限从未被确认过，月额度仅供参考。`,
    `比率 $${(Number(usd.usdPerMTokens) || 0).toFixed(2)}/M：${ratioSource}；${snapshotAge}。`,
    '标「限额」的窗口来自 Factory 402，账号在重置前不参与调度。',
    '若在 Factory 端开启了 Extra Usage 或 Droid Core，可点「重置状态」立即恢复调度。'
  ]
  if (usage.autoProtectionDisabled) {
    lines.push('该账号已禁用自动保护：限额只做展示，不会被调度器排除。')
  }
  return lines
})
</script>
