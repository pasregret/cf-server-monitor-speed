<template>
  <div id="tab-donation" class="tab-content" :class="{ active: activeTab === 'donation' }">
    <div class="settings-section donation-section">
      <div class="section-title"><span>▸</span> {{ trans.donationTitle }}</div>

      <div class="donation-content">
        <div class="donation-copy">
          <p>{{ trans.donationDesc }}</p>
          <p>
            <a href="https://github.com/huilang-me/CF-Server-Monitor" target="_blank" rel="noopener noreferrer">
              huilang-me/CF-Server-Monitor
            </a>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  trans: {
    type: Object,
    required: true
  },
  activeTab: {
    type: String,
    default: ''
  }
})
</script>
