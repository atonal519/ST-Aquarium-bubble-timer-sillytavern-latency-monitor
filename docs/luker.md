# Luker 兼容说明

## 安装

精简版仍通过扩展管理器安装。它保留 Luker 的 `window.fetch` 代理，在代理返回的 Response 上旁路采集；不会改成直接 HTTP，也不会读取或重放 WebSocket 消息。

完整版使用原有命令：

```sh
node install.mjs /path/to/Luker --dry-run
node install.mjs /path/to/Luker
```

安装器识别 `runLukerDispatch` 架构，为 chat-completions 的 provider dispatch 加监控包装，跳过原版 SillyTavern 的九处旧锚点。安装前检查补丁和语法，不兼容时不放置文件或删除重复安装。升级 Luker 后先重新 dry-run，再安装。卸载仍使用 `--uninstall`。

源码兼容性检查覆盖 Luker `90d80f774` 与 `f18f73ca006318beacac5db0eed762a32f02a561`。这是源码/合成测试验证，尚未连接真实模型或在用户服务器部署验收。

## 采集边界

- 只覆盖 `/api/backends/chat-completions/generate`；不覆盖 NovelAI、Kobold、text-completions 或生图请求。
- 服务端在一次 provider dispatch 中采集，因此浏览器重连重放不会重复落盘。Luker 的 job 恢复、自动保存、取消和 WebSocket 生命周期仍由 Luker 管理。
- 不把 HTTP 返回的 `{}` 确认包当成模型回复；读取 dispatch 发出的流式或 JSON 数据。
- 元数据 GET 请求计入预处理；首个 provider POST 作为上游请求开始。多次 provider POST/重试的分段仍按一次生成归并，不能逐次拆开。
- 用量仅记录 provider 实际返回的字段。Luker 适配不修改 provider 请求体，不强制加入 `stream_options.include_usage`；上游未返回用量时，token/成本可能为空。
- 显式 job AbortSignal 用来识别用户停止。瞬时 WS 断开不等同于停止生成。
- 监控写盘异步完成，不阻塞 Luker 的生成任务收尾。进程在写入前被终止时，最后一条记录可能丢失。
- 错误诊断保留余额不足、模型不存在、限流等原始描述，以及可用的嵌套 error/code/status，最多 2048 字符；已知请求凭据和常见 Authorization/Bearer、API key、token、密码、URL 凭据字段尽力脱敏。不会保存错误对象的 stack、请求配置或任意 data/body 字段。HTTP 错误体只解析不超过 32 KiB 的结构化 JSON 错误，不保存原始 HTML。
- 脱敏不保证识别全部自定义秘密格式；上游错误描述也可能回显用户内容，分享或导出记录前仍需检查。本改动不改变原版 SillyTavern 的错误记录行为。
- 不新增原始消息/回复正文的专门持久化字段。非流式 JSON 暂存上限 8 MiB，超限不提取正文长度和用量。流式沿用现有 SSE 解析器。
- 存储仍沿用鱼缸的 `data/default-user/latency-monitor/`，本改动没有实现多用户存储隔离。仅用于已接受该存储模型的部署。
- 精简版响应在异步初始化前立即克隆，避免初始化较慢时原响应已被读取。耗时仍是浏览器侧观测，初始化延迟可能影响响应阶段时间，不等于服务端精确分段。

## 无网络回归测试

```sh
node --test scripts/test-luker-monitor.mjs scripts/test-frontend-response-capture.mjs tests/installer.test.mjs
node scripts/check-browser-safety.mjs
```

测试使用合成数据，包括真实 Node Response/ReadableStream、真实监控落盘到临时目录、流式/非流式、取消、错误、重复终止、重连重放边界、初始化延迟、安装幂等和卸载还原。不会调用模型接口。
