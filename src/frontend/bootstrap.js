import { initConfig } from './utils/config'
import { startStartupReads } from './utils/startupReads'

// This inline entry executes before the large application's module download.
const preloads = JSON.parse(document.currentScript?.dataset.cfsmPreload || '[]')
void initConfig().then(() => startStartupReads(preloads)).catch(() => { /* Normal startup remains available. */ })
