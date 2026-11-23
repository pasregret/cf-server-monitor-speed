<template>
  <p v-if="warning" class="traffic-warning" :class="{ 'traffic-warning-limit': warning.level === 'limit' }" role="status">
    ⚠ {{ trans.trafficAlertThreshold }} {{ formatBytes(warning.thresholdBytes) }}:
    {{ formatBytes(warning.usedBytes) }} / {{ formatBytes(warning.limitBytes) }}
  </p>
</template>

<script setup>
import { computed } from 'vue'
import { formatBytes } from '../utils/api'
import { useTranslation } from '../utils/i18n'
import { getTrafficWarning } from '../utils/traffic.js'
const props = defineProps({ server: { type: Object, required: true } })
const trans = useTranslation()
const warning = computed(() => getTrafficWarning(props.server))
</script>

<style scoped>
.traffic-warning {
  margin: 0.5rem 0;
  color: var(--accent-yellow);
  font-size: 0.85rem;
  line-height: 1.4;
}
.traffic-warning-limit { color: var(--accent-red); }
</style>
