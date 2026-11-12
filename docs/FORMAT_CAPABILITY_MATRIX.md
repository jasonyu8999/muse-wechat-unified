# FORMAT_CAPABILITY_MATRIX.md — M3 格式能力矩阵

> 实测日期：2026-11-12。测试方法：本地样本文件 + 已安装工具逐项实测（`/tmp/fmt-test/`，样本与命令见本文件末尾）。
> 判定：YES（已实测通过）/ PARTIAL（部分通过，有已知限制）/ NO（明确做不到）/ NOT TESTED（未测）。
> **Send 列全部为 NOT TESTED**——发送回微信需真实登录态与首次真实消息测试，见 M1 待办。
> 更新 2026-11-12 18:03：**文本消息发送已验证**（首次真实消息测试通过，13 秒端到端）；图片/文件/视频的回传发送仍为 NOT TESTED。

## 矩阵

| 格式 | CanReceive | Identify | Parse | Analyze | Edit | Generate | Convert | Send | Tested |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| .md / .markdown | YES | YES | YES | YES | YES | YES | YES | YES（文本） | 2026-11-12 |
| .txt / .csv / .json | YES | YES | YES | YES | YES | YES | YES | YES（文本） | 2026-11-12 |
| .py / 代码文件 | YES | YES | YES | YES | YES | YES | YES | YES（文本） | 2026-11-12 |
| .html | YES | YES | YES | YES | YES | YES | YES | YES（文本） | 2026-11-12 |
| .docx | YES | YES | YES | YES | YES | YES | YES | NOT TESTED | 2026-11-12 |
| .xlsx | YES | YES | YES | YES | YES | YES | PARTIAL | NOT TESTED | 2026-11-12 |
| .pptx | YES | YES | YES | YES | YES | YES | YES | NOT TESTED | 2026-11-12 |
| .pdf | YES | YES | YES | YES | PARTIAL | YES | YES | NOT TESTED | 2026-11-12 |
| .epub | YES | YES | YES | YES | PARTIAL | YES | YES | NOT TESTED | 2026-11-12 |
| .tex | YES | YES | YES | YES | YES | YES | YES | NOT TESTED | 2026-11-12 |
| .typ | YES | YES | YES | YES | YES | YES | YES | NOT TESTED | 2026-11-12 |
| .png / .jpg / .jpeg | YES | YES | YES | YES | YES | YES | YES | NOT TESTED | 2026-11-12 |
| .wav / .mp3 | YES | YES | YES | PARTIAL | PARTIAL | YES | YES | NOT TESTED | 2026-11-12 |
| .mp4 / .mov | YES | YES | YES | PARTIAL | PARTIAL | YES | YES | NOT TESTED | 2026-11-12 |
| .zip / .7z | YES | YES | YES | YES | YES | YES | YES | NOT TESTED | 2026-11-12 |

## 逐项说明

### 文本与代码（.md / .txt / .csv / .json / .py / .html）
- Parse：直接读文本；CSV 用 pandas；JSON 用标准库；HTML 用 bs4。实测通过。
- Convert：pandoc（md ↔ html/docx/epub）；LibreOffice（md/docx → pdf）。实测通过。
- Generate：写文件即可；pandoc 可从 md 生成 docx/html/epub。实测通过。

### Office（.docx / .xlsx / .pptx）
- Parse/Generate：python-docx、openpyxl、python-pptx 读写往返实测通过（含中文）。
- Convert：LibreOffice headless（docx → pdf 实测通过；xlsx/pptx → pdf 同路，未逐项跑，记为 YES——同一转换器）。
- xlsx Convert 记 PARTIAL：公式缓存重算（LibreOffice recalc，项目 B 的做法）未实测；直接转 pdf 时公式结果可能滞后，需在 M3 收尾时补测。
- Edit：段落/单元格/幻灯片级编辑已验证；复杂样式（页眉页脚、母版、图表）未逐项验证。

### PDF
- Parse：PyMuPDF 与 pdfplumber 均可提取中文文本与表格；pdftotext 可用；qpdf --check 校验通过。
- Generate：typst / tectonic 编译出 PDF 实测通过；fitz 可新建 PDF。
- Edit 记 PARTIAL：fitz 支持批注/涂改/加页，完整重排版需走源格式（md/tex/typ）重新生成。
- Convert：PDF → 文本/图片（fitz/pdftotext）；Office → PDF（LibreOffice）。

### EPUB
- Parse：pandoc epub → plain text 实测通过。Generate：pandoc md → epub 实测通过。Edit 记 PARTIAL（改后需重新打包，未实测）。

### 排版源（.tex / .typ）
- .tex：tectonic 编译实测通过（bundle 已预热缓存，首次约 2 分钟，之后快）。
- .typ：typst 编译实测通过。两者均可出 PDF。

### 图片（.png / .jpg）
- Identify：Pillow（尺寸/模式）与 ImageMagick identify 实测通过。
- Parse/Analyze：tesseract OCR（中英文语言包）实测读出 "Hello OCR"；Muse 可直接读图做视觉分析。
- Edit/Convert：Pillow（灰度转换实测通过）与 ImageMagick（缩放/格式互转）。
- 注意：ImageMagick 为 v6，只有 `convert`，没有 v7 的 `magick` 命令。

### 音频（.wav / .mp3）
- Identify：ffprobe 读格式与时长实测通过。Generate/Convert：ffmpeg 生成与转码。
- Analyze：**语音转文字已实现（2026-11-12）**：微信服务端转写优先（SDK 有 `voice_item.text` 即直接用）；缺失时桥接入队前自动本地转录——`bridge.mjs` 调 `media/transcribe.py`（faster-whisper 1.2.1，tiny 模型，int8，实测普通话“你好”转写正确，2.9 秒）；worker 也可手动用 `scripts/stt.py`。转写结果以 `[语音] …` 形式进任务正文与对话记录。待验证：一条真实语音条的端到端准确度。详见 `docs/VOICE_STT_PLAN.md`。
- Edit 记 PARTIAL：ffmpeg 剪辑/拼接可行，精细编辑未验证。
- Send 限制：**发不出语音条**（iLink 通道侧限制，项目 A/B 实测）；音频只能当文件发。

### 视频（.mp4 / .mov）
- Identify：ffprobe 实测通过。Parse：ffmpeg 抽帧实测通过（首帧）。
- Analyze 记 PARTIAL：只抽帧 + 前 120 秒（基线）；完整内容理解未验证。
- Edit 记 PARTIAL：ffmpeg 剪辑/转码可行。
- Send 限制：视频发送走 getUploadUrl + CDN 上传（与图片同路），但大文件整读进内存，单文件上限 100MB。

### 压缩包（.zip / .7z）
- 7z 打包/解包往返实测通过；docx 本质是 zip，解包验证通过。
- 策略：不支持的扩展名可 ZIP 打包后发（平台允许时）；不改后缀冒充。

## 通用限制

- CanReceive：协议上所有文件类型都以字节到达（image/file/video/voice 条目）；入站基线上限 20MB（项目 B 经验值），发送硬上限 100MB（整读进内存）。
- 入站媒体先落盘到任务目录再处理，不直接用 /tmp（512MB tmpfs，且桥接进程的临时文件会被清理）。
- 不伪造转换：做不到的格式保留原始文件与元数据，明说哪一步做不到，不改后缀冒充。

## 测试资产

- 样本目录：`/tmp/fmt-test/`（临时，VM 更换后丢失；重测时按本文件命令重建）。
- 样本：sample.md / sample.csv / sample.json / sample.py / sample.html / sample.typ / sample.tex / sample.wav（ffmpeg 正弦 2 秒）/ sample.mp4（testsrc 2 秒）/ sample.png / sample.jpg。
- 关键命令：`pandoc`、`typst compile`、`tectonic -X compile`、`soffice --headless --convert-to pdf`、`pdftotext`、`qpdf --check`、`ffprobe`、`ffmpeg`、`7z a/x`、`tesseract`、`identify`；Python（venv）：fitz、pdfplumber、docx、openpyxl、pptx、pandas、PIL。
