import { normalizeTimestamp } from './time.js'
import { NUMERIC_METRIC_FIELDS, PROBE_METRIC_FIELDS } from '../../utils/historyFields.js'

const runtimeFields = new Set([...NUMERIC_METRIC_FIELDS, ...PROBE_METRIC_FIELDS,
  'load_avg', 'gpu_info', 'disk_io', 'os', 'kernel_version', 'cpu_info', 'arch',
  'agent_version', 'boot_time', 'uptime', 'ip_v4', 'ip_v6',
  'sample_timestamp', 'timestamp', 'report_timestamp', 'last_updated'])
export const metricPayload = value => Object.fromEntries(Object.entries(value || {}).filter(([key]) => runtimeFields.has(key)))

export const sampleTimestamp = value => normalizeTimestamp(value?.sample_timestamp ?? value?.timestamp ?? value?.last_updated, null)
export const reportTimestamp = value => normalizeTimestamp(value?.report_timestamp ?? value?.last_updated, null)

export function acceptsSample(current, sampleTs, reportTs) {
  const incoming = normalizeTimestamp(sampleTs, null)
  if (!incoming) return false
  const previous = sampleTimestamp(current)
  if (!previous || incoming > previous) return true
  if (incoming < previous) return false
  const previousReport = reportTimestamp(current)
  const nextReport = normalizeTimestamp(reportTs, incoming)
  return !previousReport || nextReport > previousReport
}

export function latestReportSample(update) {
  let latest = null
  for (const sample of update?.samples || []) {
    const data = sample?.data || sample?.payload || sample?.metrics
    const ts = normalizeTimestamp(sample?.ts ?? sample?.timestamp ?? sampleTimestamp(data), null)
    if (data && ts && (!latest || ts > latest.ts)) latest = { data, ts }
  }
  if (!latest) return null
  return { ...latest, reportTs: normalizeTimestamp(update.reportTs ?? update.report_timestamp, latest.ts) }
}

export function mergePendingSamples(previous, incoming, afterTs = 0, limit = 600) {
  const samples = new Map()
  for (const sample of [...(previous || []), ...incoming]) {
    if (sample.ts <= afterTs) continue
    const current = samples.get(sample.ts)
    if (!current || (sample.reportTs || 0) >= (current.reportTs || 0)) samples.set(sample.ts, sample)
  }
  return [...samples.values()].sort((a, b) => a.ts - b.ts).slice(-limit)
}

// Newer live metrics override only the metric payload, leaving REST inventory
// fields (name, budget, grouping, etc.) authoritative. Never max monthly bytes:
// a genuinely newer reset is allowed to reduce a counter.
export function mergeInventoryState(inventory, live, previousInventory = null) {
  const ordered = previousInventory && !acceptsSample(previousInventory, sampleTimestamp(inventory), reportTimestamp(inventory))
    ? { ...inventory, ...metricPayload(previousInventory) } : inventory
  if (!live || acceptsSample({ sample_timestamp: live.ts, report_timestamp: live.reportTs }, sampleTimestamp(ordered), reportTimestamp(ordered))) return ordered
  return { ...ordered, ...metricPayload(live.data), sample_timestamp: live.ts, timestamp: live.ts,
    report_timestamp: live.reportTs, last_updated: live.reportTs }
}
