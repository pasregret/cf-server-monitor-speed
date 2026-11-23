# CF-Server-Monitor Speed v0.1.0

这是 CF-Server-Monitor Speed 的首版。它基于 [huilang-me 的 CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor)，由 leon4z 独立维护，重点是缩短面板打开后的等待时间。

## 首版变化

- 页面开始下载主程序时，提前发起首页的配置和主机清单请求。配置与清单并行读取，版本检查在页面加载后进行。
- 首页先展示已保存的指标。已登录的单站首页提前连接 WebSocket，沿用同一条连接补齐缓存快照和后续实时上报。
- JetBrains Mono 随面板打包。首页和详情支持对选定主机显示月流量额度提醒。

## 性能对照

提前发起首页请求的那一轮，在同一线路、同一 Chrome 环境和四台受监控主机下，冷启动首屏中位数由 **1.498 秒**降至复测的 **1.213 秒**，缩短约 **19%**。每组 3 次冷加载，首屏以主机卡片、月流量和网络质量已渲染且遮罩已撤除为准。这个数字对应请求前移这一项优化的对照，实际耗时会随线路及缓存状态变化。

## 安装与版本

按 [部署说明](README.md#快速部署)在 Cloudflare 创建新实例。面板版本从 `v0.1.0` 开始，面板在本仓库检查稳定发行版本。Go Agent 继续使用独立的 [上游 cfsm-agent](https://github.com/huilang-me/cfsm-agent)，原部署已使用 `v1.1.3` 验证。

从上游面板迁入前，请备份原实例，在独立环境验证配置、历史和探针上报。源码提交沿革见 [FORK.md](FORK.md)，原版权和许可见 [LICENSE](LICENSE)。
