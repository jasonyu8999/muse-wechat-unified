# ENVIRONMENT_AUDIT.md — M0 环境审计

> 审计日期：2026-11-12。审计方式：本机实测（命令输出）+ 官方/本地文档 + 三路研究笔记。
> 判定：VERIFIED（已实测）/ AVAILABLE_UNTESTED（机制存在，未针对本项目实测）/ UNSUPPORTED（明确不支持）/ UNKNOWN（无证据）。
> 证据时间均为 2026-11-12 CST；网络类结论以当日实测为准。

## 审计结果总览

| # | 项目 | 判定 |
|---|---|---|
| 1 | Muse 账号与运行环境 | VERIFIED |
| 2 | Secure VM 文件系统访问能力 | VERIFIED |
| 3 | 持久化工作目录 | VERIFIED |
| 4 | Hook / Wake / Worker 支持 | VERIFIED（机制）；微信唤醒链路 AVAILABLE_UNTESTED |
| 5 | 用户自定义周期任务 | VERIFIED |
| 6 | 受控后台常驻进程 | AVAILABLE_UNTESTED（systemd）；nohup 进程 VERIFIED |
| 7 | 原生记忆访问方式 | VERIFIED |
| 8 | App 与 Hook Worker 共享长期记忆 | VERIFIED（机制）；双向读写行为测试 AVAILABLE_UNTESTED |
| 9 | App 与 Hook Worker 共享项目和文件权限 | VERIFIED（机制）；行为测试 AVAILABLE_UNTESTED |
| 10 | 已连接工具及连接器 | VERIFIED |
| 11 | DeepSeek Harness 实际调用接口 | VERIFIED |
| 12 | Python、Node.js、Shell 和媒体工具版本 | VERIFIED |
| 13 | 已有微信桥接程序、监听器和登录态 | VERIFIED（均不存在/未登录） |
| 14 | 端口、网络、资源配额与执行时间限制 | VERIFIED（网络/端口）；配额 UNKNOWN |
| 15 | 获取任务状态和结果的支持方式 | VERIFIED（机制）；微信 TaskService 待建 |
| 16 | 文件解析器、转换工具、编译环境及多媒体依赖 | VERIFIED |
| 17 | Muse 原生支持的文件类型及处理操作 | AVAILABLE_UNTESTED |

## 逐项审计

### 1. 当前 Muse 账号与运行环境 — VERIFIED

- 智能体：Beacon（用户 2026-11-04 选定），主聊天 `ae3fbb51-463a-4851-9fae-aee31a29e60d`，时区 Asia/Shanghai。
- VM：Ubuntu 24.04.5 LTS，内核 7.0.0-44-generic，x86_64，4 vCPU，7.9 GiB 内存，以 root 运行。
- 运行时：Node v24.22.1、npm 10.9.4、Python 3.12.3、git 2.43.0、gh 2.102.0。
- 证据：`uname -a`、`node --version` 等实测输出；2026-11-12 17:34 时 VM 刚重启过（uptime 5 分钟），属正常更换。

### 2. Secure VM 的文件系统访问能力 — VERIFIED

- home（`/home/hatch`）：150G，149G 可用，可读写；`/` overlay 7.5G（可用 7.5G）；`/tmp` 为 512MB tmpfs（不可放大文件）。
- 证据：`df -h` 实测。注意：大文件克隆/解压不得放 `/tmp`。

### 3. 是否提供持久化工作目录 — VERIFIED

- `~/workspace` 随 home 持久保留（VM 更换后仍在）；`~/.local/bin`、`~/.cache`、项目 venv 同理。
- 临时：`/tmp`、apt 安装的系统包、运行中进程在 VM 更换后丢失。
- 证据：DeepSeek Harness 安装（`~/workspace/dsh`）在多次 VM 更换后仍在；本次审计的 venv 与二进制安装均在 home 下。

### 4. 是否支持 Hook / Wake / Worker — VERIFIED（机制）；微信唤醒链路 AVAILABLE_UNTESTED

- Hook 机制存在：`hooks` 工具命名空间；`~/hooks/scripts/`（轮询脚本）、`~/hooks/state/`（状态）目录已存在；脚本协议为 `source "$HATCH_HOOK_RUNTIME"` + 每轮恰一次 `silent`/`wake`；新 hook 默认禁用，先 `dry_run` 再 `enable`；轮询间隔 5 秒–7 天，脚本超时上限 600 秒；检测脚本无凭据、无连接器访问。
- Worker：hook/cron 唤醒的是同一智能体的后台回合，结果以隐藏 handoff 交主会话决定呈现；子代理（subagent）隔离、不继承 transcript、任务须自包含，但共享同一 VM 文件系统。
- 证据：`~/docs/chat/scheduling-and-watching.md`、`~/docs/scheduling-and-watching.md`；研究笔记 `research/project-c-notes.md` §1–§3；项目 A 的生产 hook（`ilink-watch.sh` 每 ~5 秒一轮）为同类机制的实证。
- 未验证：针对微信队列的 hook 唤醒链路（M1 建好后以 dry-run + 真实消息验证）。

### 5. 是否允许用户自定义周期任务 — VERIFIED

- cron 工具完整（runonce/interval/daily/weekly/monthly/yearly），须有 owner；超时默认 3600 秒、上限 86400 秒。
- 证据：天气提醒 cron `wenjiang-weather-alert-0730` 每日 07:30 Asia/Shanghai 正常运行（2026-11-05 起多次触发/送达记录）。

### 6. 是否允许受控的后台常驻进程 — AVAILABLE_UNTESTED（systemd）；nohup 进程 VERIFIED

- Guest systemd 存在：PID 1 为 systemd 255，但只启动到最小 `default.target`，非标准 multi-user.target；文档要求 unit 与状态放持久 home 存储、用绝对路径、前台进程、配 Restart 策略；仅靠 unit + Restart 不能确立 VM 更换后的恢复路径，需另有启动恢复路径。
- nohup 后台进程已验证可行：dsh web 在本次 VM 重启后用 `start-web.sh` 重新拉起，`127.0.0.1:3080` 正常监听。
- 未验证：本项目的 systemd 服务实际注册与拉起（M1/M5 做）。

### 7. 当前 Muse 的原生记忆如何被访问 — VERIFIED

- 记忆文件：`~/MEMORY.md`（精选长期记忆）+ `~/memory/`（按日记录与人物/群组）；检索工具 `muse.memory_search` / `muse.memory_get`；同一智能体的主聊天与个人 side chat 共享记忆搜索。
- 证据：本会话全程使用；`~/docs/memory.md`。

### 8. App 与 Hook Worker 是否共享长期记忆 — VERIFIED（机制）；双向读写行为测试 AVAILABLE_UNTESTED

- 机制结论：共享。Hook/Cron worker 是同一智能体的后台回合，与主会话共用同一份 `MEMORY.md`、`~/memory/` 与同一 VM；子代理共享文件系统但不共享对话上下文。
- 证据链：`~/docs/muse.md`（每用户一台专属 VM）、`~/docs/memory.md`（记忆按用户/智能体保存）、`~/docs/scheduling-and-watching.md`（后台 worker 完成后以 handoff 汇报）；研究笔记 `research/project-c-notes.md` §6。
- 未验证：规范 §6 要求的 A/B 双向读写行为测试（App 写 → Worker 读；Worker 写 → App 读），属 M2 验收内容。在测试完成前，不宣称“记忆已完全同步”。

### 9. App 与 Hook Worker 是否共享项目和文件权限 — VERIFIED（机制）；行为测试 AVAILABLE_UNTESTED

- 机制结论：共享。同一 VM、同一 home 目录、同一用户身份；`~/workspace`、goals、连接器凭据均走同一套存储与审批路径；hook 检测脚本本身无凭据，worker 回合执行工具时走正常连接器与审批路径。
- 未验证：微信任务实际读写 App 端文件与跨端任务状态查询的行为测试（M2）。

### 10. 当前已连接哪些工具及连接器 — VERIFIED

- 已连接并验证可用：Gmail、Google Calendar、GitHub（jasonyu8999；4 仓库）、自定义 Qianwen（`maas.qianwenaiapi.com`，182 个模型，含 deepseek-v4.1-flash/pro）。
- 自定义 DeepSeek 连接已登记但其 Key 实为千问平台 Key（对 api.deepseek.com 返回 401），以 custom.qianwen 为准。
- Secure Vault 有 google.com 登录；浏览器另有自有登录态。
- 证据：2026-11-04 连接确认；2026-11-12 Qianwen 端到端验证；`/opt/hatch/connectors/` 目录清单（70+ 连接器文档可用）。

### 11. 当前 DeepSeek Harness 的实际调用接口 — VERIFIED

- 已部署：`@deepseek-ai/dsh 0.2.2-rc.1`，位于 `~/workspace/dsh`；Web UI `127.0.0.1:3080`（token 保护）；启动脚本 `start-web.sh`（每次启动换取新 surrogate 注入 `QIANWEN_API_KEY`）；配置 `qianwen.patch.yml`（pi-ai OpenAI 兼容路由 `qianwen-maas`，默认模型 deepseek-v4.1-flash）。
- 调用方式：Web UI 人工操作；headless CLI（`dsh`）已验证可跑测试任务；Muse 侧无 dsh 的专用连接器，通过 CLI/Web 调用。
- 证据：2026-11-12 端到端验证（`1+1` 问答 + 模型列表）；本次审计中 VM 重启后 dsh 已重新拉起并监听 3080。
- 限制：dsh 约占 400MB 内存，VM 空闲内存常在 450–1000MB 之间波动，重型任务需注意资源。

### 12. 当前可用的 Python、Node.js、Shell 和媒体工具版本 — VERIFIED

- Node v24.22.1、npm 10.9.4、Python 3.12.3、bash、gcc/g++（有）；cargo/go/rustc（无）。
- 媒体与文档工具：详见 `docs/TOOLS_INVENTORY.md`（2026-11-12 补齐并冒烟测试通过）。
  摘要：pandoc 3.1.3、tesseract 5.3.4（eng/chi_sim/chi_tra）、ImageMagick 6.9.12（convert）、ghostscript 10.02.1、qpdf 11.9.0、7zip 23.01、ffmpeg 8.1.2、LibreOffice 24.2.7.2、typst 0.15.1、tectonic 0.17.0；项目 venv 含 PyMuPDF/pdfplumber/pypdf/bs4/python-pptx/pyarrow/sqlalchemy/cryptography/python-docx/openpyxl/pandas/Pillow/numpy/pyyaml/lxml。
- 证据：实测版本命令与冒烟测试输出。

### 13. 是否已有微信桥接程序、监听器和登录态 — VERIFIED（均不存在/未登录）

- 研究用克隆存在：`~/workspace/wechat-muse-bridge-review`（HEAD 2026-10-13，未改动）；项目 A 克隆存在：`research/project-a/`（只读研究）。
- 无任何桥接监听进程在运行（`ss` 无监听端口，`ps` 无相关进程）；无微信登录态（`~/.openclaw` 不存在）；未生成过登录二维码（仅做过一次连通性探测，见 §14）。
- 项目目录已建：`~/workspace/muse-wechat-unified/`（模块目录 + research + docs + scripts）。

### 14. 是否存在端口、网络、资源配额或执行时间限制 — VERIFIED（网络/端口）；配额 UNKNOWN

- 网络：出口经代理（HTTP(S)_PROXY）；`ilinkai.weixin.qq.com` 实测可达——`POST /ilink/bot/get_bot_qrcode?bot_type=3` 返回 200、`ret:0`、1.59 秒（含有效二维码载荷，仅作连通性探测，未向用户出示，该码已自然过期，探测文件已删除）；CDN `novac2c.cdn.weixin.qq.com` 可达（400 为路径预期）；github.com 可达（200）。
- 端口：本机仅 dsh 监听 127.0.0.1:3080；无其他监听服务；无公网 IP（不需要，iLink 为出站长轮询）。
- 资源：内存 7.9GB，可用常在 450–1000MB 之间；dsh 占 ~400MB；磁盘 home 149G 可用。
- 执行时间：cron 超时默认 3600 秒（上限 86400 秒）；hook 脚本超时上限 600 秒；dsh/桥接长任务的平台上限未见明文 — UNKNOWN。
- 配额：未见明确的 API/运行配额文档 — UNKNOWN；GitHub API 未认证调用曾遇速率限制（共享出口 IP），认证调用不受影响。

### 15. 是否能通过支持的方式获取任务状态和结果 — VERIFIED（机制）；微信 TaskService 待建

- 支持的方式存在：`cron.status` / `cron.runs`（定时任务状态与历史）、`hooks.logs`（hook 调用日志）、文件队列/账本（本地可查）、worker handoff（结果回主会话）。
- 微信侧统一 TaskService（task_id、状态机、产物、跨端查询）尚未建立，属 M1/M2 建设内容。

### 16. 当前可用的文件解析器、转换工具、编译环境及多媒体依赖 — VERIFIED

- 解析：PyMuPDF、pdfplumber、pypdf、python-docx、openpyxl、python-pptx、pandas、pyarrow、Pillow、lxml、bs4（见 `docs/TOOLS_INVENTORY.md`）。
- 转换：pandoc、LibreOffice（Office/PDF 互转）、ffmpeg（音视频）、ImageMagick（图片）、typst/tectonic（排版编译出 PDF）、qpdf、ghostscript、7zip。
- 编译环境：gcc/g++ 有；TeX Live 未装（用 tectonic 自带 bundle 代替）；Rust/Go 未装。
- 证据：逐项版本命令 + 冒烟测试（md→html、OCR、图片生成、7z 打包、typst/tectonic 出 PDF、Python 库读写）。

### 17. 当前 Muse 原生支持哪些文件类型及处理操作 — AVAILABLE_UNTESTED

- 已知路径：`documents` 技能可读 PDF/Word/Excel/PowerPoint/ODF/EPUB/RTF 并转 Markdown；`muse.read` 支持图片直接读入；媒体库可查用户照片。
- 未穷举验证：原生支持的完整文件类型清单与每种类型的读/写/转换能力未逐项实测；本项目以 venv 工具 + Muse 文件能力组合实现，不依赖未验证的原生清单。
- 格式能力以 M3 的 `FORMAT_CAPABILITY_MATRIX.md` 实测为准。

## 审计结论（M0）

- 核心链路全部具备：iLink 后端可达、Hook 唤醒机制存在、记忆与文件在同一智能体内共享、Harness 已部署、媒体工具已补齐。
- 最大待确认点（非环境问题，需实测回答）：Hook worker 发往微信的消息走何种审批授予（单任务 lasting allow 还是每次审批）——教程未提及，文档只给出通用规则；M1 以真实消息验证。
- 已知通道侧硬限制（项目 A/B 实测，非本环境问题）：发不出语音条、发不出工具进度消息（类型 11/12）、出站引用发不出去；登录态寿命不确定（24 小时传闻 vs 3 天以上实测）。
