import test from 'node:test'
import assert from 'node:assert/strict'
import { getTrafficUsageBytes, calcTrafficUsagePercent, getTrafficWarning } from '../src/frontend/utils/traffic.js'
const G = 1024 ** 3
const host = { traffic_limit: 200, traffic_calc_type: 'ul', traffic_alert_percent: 75,
  net_rx_monthly: 1000 * G, net_tx_monthly: 149 * G }

test('Oregon ignores large inbound traffic and warns exactly at 150 GiB outbound', () => {
  assert.equal(getTrafficWarning(host), null)
  const warning = getTrafficWarning({ ...host, net_tx_monthly: 150 * G })
  assert.deepEqual(warning, { usedBytes: 150 * G, limitBytes: 200 * G,
    thresholdBytes: 150 * G, level: 'warning' })
  assert.equal(getTrafficWarning({ ...host, net_tx_monthly: 200 * G }).level, 'limit')
})
test('reset clears warning; unset, disabled or invalid thresholds keep old hosts unchanged', () => {
  assert.equal(getTrafficWarning({ ...host, net_tx_monthly: 0 }), null)
  for (const value of [undefined, null, '', 0, '0', -1, 101, 'invalid']) {
    assert.equal(getTrafficWarning({ ...host, traffic_alert_percent: value, net_tx_monthly: 250 * G }), null)
  }
  assert.equal(getTrafficWarning({ ...host, traffic_limit: 0 }), null)
})
test('existing total, upload, download and maximum accounting stays equivalent', () => {
  const input = { traffic_limit: 20, net_rx_monthly: 3 * G, net_tx_monthly: 7 * G }
  for (const [kind, expected] of [['total', 10], ['ul', 7], ['dl', 3], ['max', 7]]) {
    const value = { ...input, traffic_calc_type: kind }
    assert.equal(getTrafficUsageBytes(value), expected * G)
    assert.equal(calcTrafficUsagePercent(value), expected / 20 * 100)
  }
})
