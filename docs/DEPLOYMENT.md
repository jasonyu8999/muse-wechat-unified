# DEPLOYMENT.md — 部署手册

## 环境要求

- Ubuntu 24.04 VM（4 vCPU / 8GB 内存），Node v24、Python 3.12、git。
- 出口经代理；`ilinkai.weixin.qq.com` 与 CDN 需可达。
- home 目录持久；`/tmp` 与 apt 包在 VM 更换后丢失。

## 首次部署（已完成，记录备查）

1. 装媒体与文档工具：`bash scripts/install-media-tools.sh`（apt 包 + venv + typst/tectonic）。
2. 构建传输层：`cd transport && npm install && npm run build`（复用 MIT 的 weixin-agent-sdk）。
3. 注册 Hook：`hooks.add`（脚本 `~/hooks/scripts/wechat-tasks-watch.sh`，每 15 秒）→ dry-run → enable。
4. 登录：`node bridge/bridge.mjs login` 扫码绑定（二维码约 5 分钟有效）。
5. 启动：`bash bridge/start-bridge.sh`；验证 `node bridge/bridge.mjs status`（loggedIn true，running true，心跳新鲜）。

## 日常运维

见 `docs/OPERATIONS.md`（启动/停止/状态/日志/健康检查/常见问题）。

## VM 更换后恢复

1. 重装 apt 工具：`bash scripts/install-media-tools.sh`（venv 与二进制在 home 下保留，无需重装）。
2. 重启 dsh：`bash ~/workspace/dsh/start-web.sh`。
3. 注册并启动桥接服务（/etc 与 /run 在 VM 更换后丢失，需重做；unit 原件在项目内保留）：
   ```bash
   bash scripts/setup-systemd.sh
   ```
   该脚本从当前 shell 环境生成代理 env 文件（0600，/run，凭据不进持久文件）、装 unit、daemon-reload、enable --now。登录态在 home 下保留，无需重新扫码；长轮询游标持久化，重启后从上次位置继续。
4. 验证：`node bridge/bridge.mjs status` + 发一条微信测试消息。

看门狗 cron（`wechat-bridge-watchdog`，每 15 分钟）会在桥接进程死了且登录态存在时自动拉起；VM 更换后 cron 本身由运行时恢复。

systemd 注册已验证（2026-11-12 18:07）：服务 active (running)，从 nohup 迁移无缝，长轮询从上次 sync buf 继续。注意：unit 的 StartLimitIntervalSec/StartLimitBurst 必须放在 [Unit] 段，放 [Service] 段会被忽略并告警。

## 回滚

- 桥接代码：git 外的本地文件，改动前先备份 `bridge/` 目录。
- 登录态：`bridge/state/` 备份后可恢复；泄露时重新扫码。
- Hook：`hooks.disable` 停用即停止唤醒；桥接进程 `stop-bridge.sh` 停止即停止收发。
