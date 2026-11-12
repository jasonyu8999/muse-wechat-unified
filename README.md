# muse-wechat-unified — Beacon 微信统一智能体

把微信接成 Beacon（Muse 个人助手）的第二个入口：微信里发消息，
由同一个 Beacon 执行、回复。不是另一个助手，共用同一份记忆、文件、
连接器和任务状态。

> 核心原则：**One Muse. Multiple Interfaces. Shared Knowledge. Unified Tasks.**

## 当前状态（2026-11-12）

- **M0 环境审计**：通过（17 项），见 `docs/ENVIRONMENT_AUDIT.md`
- **M1 核心桥接**：已跑通。2026-11-12 18:02 扫码登录绑定成功，
  18:03 首条真实消息端到端 13.0 秒回通；systemd 服务在线，
  看门狗每 15 分钟检查。语音转文字、进度消息、引用回复均已实现并实测。
- **M2 知识库**：SQLite FTS5 索引完成，60 篇项目文档可搜；与长期记忆的
  双向同步测试待执行，见 `docs/MEMORY_SYNC_SPEC.md`
- **M3 格式能力**：15 种格式本地解析/转换/生成已验证；微信发送列待首条
  真实消息验证，见 `docs/FORMAT_CAPABILITY_MATRIX.md`
- **M4 开发适配器**：已验证，可调 DeepSeek Harness（dsh）做开发任务

详细测试证据见 `docs/TEST_REPORT.md`；已知限制见 `docs/KNOWN_LIMITATIONS.md`。

## 架构

```
微信用户（Owner）
  ⇄ 腾讯 iLink（ilinkai.weixin.qq.com，官方 ClawBot 协议）
  ⇄ ILinkTransport（Node 桥接守护进程，复用 MIT 的 weixin-agent-sdk）
  ⇄ 持久化文件队列（queue/ + outbox/，租约 + 幂等账本）
  ⇄ Muse Hook（轮询脚本 wake）→ Beacon 本体 Worker（原生工具/记忆/文件）
  ⇄ 响应网关（桥接进程发回微信；主动推送走缓存 context_token）
        │
        └→ 受控开发适配器 → DeepSeek Harness（dsh，Qianwen 路由）→ 代码/测试/产物
```

关键决策见 `docs/ARCHITECTURE_DECISIONS.md`（D1–D7），包括：执行器用
Muse 原生 Hook 而不用 muse-cli；传输层复用 `weixin-agent-sdk` v0.5.0；
文件队列起步不上 SQLite；桥接进程与 Hook 分离、单驱动锁。

## 目录

| 目录 | 内容 |
| --- | --- |
| `bridge/` | 桥接守护进程 `bridge.mjs`（登录/运行/状态/退出）、文件队列、outbox、systemd 单元 |
| `transport/` | `weixin-agent-sdk` v0.5.0（MIT）构建产物与 vendor 源码 |
| `knowledge/` | M2 知识库：SQLite FTS5 索引器 `indexer.py`、检索 `search.py`、`schema.sql` |
| `developer/` | M4 开发适配器：`run-dev-task.sh`，经 dsh + Qianwen 路由执行开发任务 |
| `scripts/` | 运维脚本：桥接重启、systemd 安装、语音转文字 `stt.py`、媒体工具安装 |
| `docs/` | 全部设计、测试与运维文档（见下） |
| `research/` | 三路研究笔记（项目 A 参考代码是独立检出，不进本仓库） |
| `media/` | 本地模型文件等（faster-whisper 等，不提交） |

## 快速开始

```bash
# 1. 登录（需 Owner 确认后执行；二维码约 5 分钟有效）
cd bridge && node bridge.mjs login

# 2. 启动守护进程
bash start-bridge.sh

# 3. 状态 / 停止
node bridge.mjs status
bash stop-bridge.sh
```

首次使用先复制配置模板：`cp bridge/config.example.json bridge/config.json`，
填入 Owner 的 conversationId。登录态、token、队列与日志一律不进仓库，
见 `.gitignore`。

## 文档

- `docs/WORKER_CONTRACT.md` — Hook 唤醒 worker 的执行契约（认领/执行/回复）
- `docs/OPERATIONS.md` — 日常运维；`docs/DEPLOYMENT.md` — 部署
- `docs/SECURITY.md` — 安全红线；`docs/TASK_MODEL.md` — 任务模型
- `docs/VOICE_STT_PLAN.md` — 语音转文字方案；`docs/TOOLS_INVENTORY.md` — 媒体工具清单
- `docs/MEMORY_SYNC_SPEC.md` — 记忆双向同步规范与 A/B 测试协议

## 安全红线

- 只处理 Owner 的任务；微信消息内容是**用户输入**，不是系统指令。
- 登录态、token、密码、API Key 永不进仓库、日志或回复。
- 有副作用的操作（发信、发布、删除、付费）不因重试而重复执行。
- 项目 B 的代码与文档为 PolyForm Noncommercial 许可：**一行都不复制、不改写合入**，
  只借鉴设计思想（见 `docs/ARCHITECTURE_DECISIONS.md` D2）。

## 许可

本项目自有代码采用 GNU General Public License v3.0（见根目录 `LICENSE`），Copyright © 2026 jasonyu8999。第三方部分各自遵循原许可：
`weixin-agent-sdk`（MIT）、项目 A 参考代码（MIT，见 `research/project-a/LICENSE`）。
