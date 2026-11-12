# 媒体与文档工具清单

> 安装日期：2026-11-12。安装脚本：`scripts/install-media-tools.sh`（可重复执行，幂等）。
> 审计时缺失的工具已全部补齐并逐项实测通过。

## 系统工具（apt 安装，临时：VM 更换后需重跑脚本）

| 工具 | 版本 | 验证 |
| --- | --- | --- |
| pandoc | 3.1.3 | md → html 实测通过 |
| tesseract | 5.3.4，语言包 eng / chi_sim / chi_tra / osd | 生成图 OCR 出 "Test" |
| ImageMagick（convert，v6，无 magick 命令） | 6.9.12-98 | 生成 200x100 PNG 通过 |
| ghostscript（gs） | 10.02.1 | 版本命令通过 |
| qpdf | 11.9.0 | 版本命令通过 |
| 7zip（7z） | 23.01 | 打包/列出通过 |
| ffmpeg（审计前已装） | 8.1.2 | 版本命令通过 |
| LibreOffice（soffice，审计前已装） | 24.2.7.2 | md → pdf 实测通过 |
| pdftotext（审计前已装） | 24.02.0 | 版本命令通过 |
| sqlite3 / jq / unzip（审计前已装） | — | 可用 |

## 二进制工具（~/.local/bin，持久：随 home 保留）

| 工具 | 版本 | 来源 | 验证 |
| --- | --- | --- | --- |
| typst | 0.15.1 | GitHub Releases，x86_64-unknown-linux-musl | 编译 .typ → 8777 字节 PDF 通过 |
| tectonic | 0.17.0 | GitHub Releases，x86_64-unknown-linux-musl | 编译 .tex → 12243 字节 PDF 通过 |

注意：

- 默认 PATH **不含** `~/.local/bin`，调用请用绝对路径 `$HOME/.local/bin/typst`、`$HOME/.local/bin/tectonic`。
- tectonic 首次编译需下载 TeX bundle（很多小文件，约 2 分钟），已预热并缓存在 `~/.cache/Tectonic`，之后编译很快。bundle 缓存在 home 下，VM 更换后保留。
- ImageMagick 是 v6，提供 `convert`，没有 v7 的 `magick` 命令；按 v6 用法调用即可。

## Python 库（项目 venv：`~/workspace/muse-wechat-unified/.venv`，持久）

系统 python3 受 PEP 668 保护，拒绝直接 pip 安装；项目使用独立 venv。

| 库 | 版本 | 验证 |
| --- | --- | --- |
| PyMuPDF（fitz） | 2.1 | 新建 PDF、写字通过 |
| pdfplumber | 0.11.10 | 读回 fitz 生成的 PDF 文本通过 |
| pypdf | 7.0.1 | 导入通过 |
| beautifulsoup4（bs4） | 4.15.0 | 导入通过 |
| python-pptx（pptx） | 1.0.2 | 新建幻灯片通过 |
| pyarrow | 26.0.1 | 建表 2 行通过 |
| sqlalchemy | 2.1.8 | 导入通过 |
| cryptography | 50.0.2 | 导入通过（iLink 媒体 AES 加密需要） |
| python-docx（docx） | （venv 内已装） | 导入通过 |
| openpyxl / pandas / Pillow / numpy / pyyaml / lxml | （venv 内已装） | 导入通过 |
| qrcode | （venv 内已装，2026-11-12 补） | 生成登录二维码图片通过（把 liteapp URL 本地编码成 PNG；直接 fetch 该 URL 只会得到 JS 渲染页的 HTML） |

调用方式：`~/workspace/muse-wechat-unified/.venv/bin/python`。
