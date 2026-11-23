// Shared monthly-byte interpretation for cards and their opt-in warnings.
export const getTrafficUsageBytes = (server) => {
  const rx = parseFloat(server.net_rx_monthly) || 0
  const tx = parseFloat(server.net_tx_monthly) || 0
  const calcType = server.traffic_calc_type || 'total'
  if (calcType === 'dl') return rx
  if (calcType === 'ul') return tx
  if (calcType === 'max') return Math.max(rx, tx)
  return rx + tx
}

export const calcTrafficUsagePercent = (server) => {
  const limit = parseFloat(server.traffic_limit) || 0
  if (limit <= 0) return 0
  return (getTrafficUsageBytes(server) / (limit * 1024 ** 3)) * 100
}

export function getTrafficWarning(server) {
  // An unset per-host threshold keeps existing hosts visually unchanged.
  const limit = Number(server.traffic_limit)
  const percent = Number(server.traffic_alert_percent)
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(percent)
      || percent <= 0 || percent > 100) return null
  const usedBytes = getTrafficUsageBytes(server)
  const limitBytes = limit * 1024 ** 3
  const thresholdBytes = limitBytes * percent / 100
  if (!Number.isFinite(usedBytes) || usedBytes < thresholdBytes) return null
  return { usedBytes, limitBytes, thresholdBytes,
    level: usedBytes >= limitBytes ? 'limit' : 'warning' }
}
