# 语音转文字（读语音条）实施计划

> 来源：用户 2026-11-12 18:15 微信要求：“自主优化一下，加入能语音转文字、能读我语音条的功能，如果可行的话，告诉我怎么办”。
> 状态：**已落地可用**。本地 STT 装好、流程跑通（2026-11-12 18:20）；中文转写准确度待一条真实语音条验证。

## 结论

**可行。** 语音条本来就能收到，不用改桥接；缺的只是“没带服务端转写时的转写”这一步。
三条路按推荐顺序：① 本地 faster-whisper（免费、语音不出本机）；② 微信服务端转写（已自动生效）；③ 千问云端 ASR（接口未打通，暂不推荐）。

## 已验证的事实（2026-11-12 实测）

### 1. 语音条能收到，不用改桥接

- SDK 有 `VOICE` 消息类型（`transport/dist/api/types.js`）。
- 带微信服务端转写文字的语音条，到达时直接就是文本（`transport/dist/messaging/inbound.js:69`：`voice_item.text` 有值即用作正文）。
- 不带转写的语音条：SDK 下载 SILK → `silk-wasm` 转 WAV（`transport/dist/media/media-download.js:35-53`，`silk-wasm` 已装在 `transport/node_modules`），`bridge.mjs` 原样拷到 `media/inbound/<任务id>/`，worker 收到的是带 `media` 字段的任务。
- 入站基线上限 20MB；语音条一般远小于此。
- 反向限制不变：**发不出语音条**（通道侧硬限制，只能发文字/文件）。

### 2. 千问云端 ASR：模型在，但这个 MaaS 端点传不进音频（已实测失败）

在 `https://maas.qianwenaiapi.com/compatible-mode/v1`（用户现有千问 key）上实测：

| 尝试 | 结果 |
|---|---|
| `POST /chat/completions`，`qwen-audio-3.0-asr-flash` / `fun-asr-flash-2026-06-15`，`input_audio` + base64 wav | 400，空 body |
| 同上，`qwen3.8-omni-flash` / `qwen3-omni-flash` | 400：`The provided URL does not appear to be valid`（网关把 base64 当 URL 解析） |
| `audio_url` + data URI | 400：不支持 `audio_url`，支持 `text/input_audio/image_url/video_url/video/file` |
| `file` + data URI | 400：`does not support PDF file input`（`file` 只认 PDF） |
| `POST /audio/transcriptions`（multipart） | 404（无此路由） |
| `qwen3-tts-flash` 对照（为造测试音频） | 400：`Due to invalid text, invalid audio was returned` |

结论：该 MaaS 网关的 chat completions 目前不接受 base64 音频；要走云端 ASR 需另找传音频的办法
（公网 URL 涉及隐私，不推荐；或走阿里云 DashScope 官方文件上传 API，需要另一套 key，不在本次范围）。
模型列表里确实有 `qwen-audio-3.0-asr-flash`、`fun-asr-flash-2026-06-15`、`qwen3.8-omni-flash`，但“列得出”不等于“调得通”。

### 3. 本地 STT：faster-whisper（已落地，2026-11-12 18:20 验证通过）

- 环境已有 ffmpeg；`faster-whisper 1.2.1` 已装入项目 venv（`~/workspace/muse-wechat-unified/.venv`）。
- 模型 `tiny`（约 75MB）已下载到 `~/.cache/huggingface`，加载约 62 秒（首次），转写 2 秒音频约 3 秒。
- 绕过一个坑：pip 装的 `av 19.0.2` 与 faster-whisper 1.2.1 不兼容（`metadata_errors` 参数报错），
  `scripts/stt.py` 改走 ffmpeg 解码 + numpy 数组喂模型，不依赖 PyAV。
- 实测：`scripts/stt.py /tmp/asr-tone.wav`（440Hz 正弦波，无语音）exit 0、输出为空，符合预期；
  内存占用正常（转写时可用内存约 950MB）。
- 中文真实语音的转写准确度尚未验证——待用户发一条语音条实测。

## 实施步骤（已完成 1–2，待真实语音验证 3）

0. ✅ **入队自动转录（2026-11-12 18:23，主聊天补）**：`bridge.mjs` 的 Agent 在语音消息入队前先转录——有微信服务端转写直接用（`transcriptSource: wechat-server`），否则调 `media/transcribe.py`（与 `scripts/stt.py` 同路：ffmpeg 解码 + numpy 数组，绕过 av 19 不兼容；模型在 `media/models/`，tiny，`--language zh`，超时 120 秒），结果以 `[语音] …` 进任务正文与对话记录（`transcriptSource: local-whisper-tiny`）；转录失败不拦任务，任务照常入队并记 `transcriptError`。普通话“你好”实测转写正确（2.9 秒）。与 `scripts/stt.py` 是同一功能两条路：入队自动（transcribe.py）+ worker 手动（stt.py），不冲突。

1. ✅ `scripts/stt.py`：输入 wav/silk 路径 → faster-whisper 转写 → 输出文字；silk 先用 ffmpeg 转 wav。
2. ✅ Worker 流程（约定，非代码）：任务带语音 `media` 时，先看正文是否已有服务端转写；没有则调 `stt.py`，
   把转写文字当作任务正文处理，回复里标注“语音转写（本地识别，可能有误差）”。
3. ⏳ 用户发一条真实语音条 → 核对转写文字 → 记录到 `docs/TEST_REPORT.md`；不准则换 `base` 模型。
4. 备选：若本地内存扛不住，改走 DashScope 官方 ASR（需用户另给 key）或等 MaaS 网关支持音频上传。

## 自主优化（本次一并做的）

- 语音链路核查（上面第 1 节）与云端接口实测（第 2 节），结论写入本文档与 `KNOWN_LIMITATIONS.md`。
- faster-whisper 装入项目 venv（不在系统 Python 里装，避免污染）。
- 后续：`stt.py` 落地后，worker 契约加一条“语音任务先转写再执行”。
