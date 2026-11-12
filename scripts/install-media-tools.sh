#!/usr/bin/env bash
# muse-wechat-unified: install media & document tools (reproducible setup)
# 用法: bash scripts/install-media-tools.sh
# - apt 包: 临时的（VM 更换后 /usr 会被重置），更换后需重新跑本脚本。
# - Python venv 与 ~/.local/bin 二进制: 在 $HOME 下，VM 更换后保留。
# - 注意: 默认 PATH 不含 ~/.local/bin，调用 typst/tectonic 请用绝对路径。
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
DL_DIR="$PROJECT_DIR/.cache/downloads"
VENV_DIR="$PROJECT_DIR/.venv"
TYPST_VERSION="0.15.1"
TECTONIC_VERSION="0.17.0"

echo "== 1/3 apt packages (ephemeral, needs root) =="
if command -v apt-get >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    pandoc tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim tesseract-ocr-chi-tra \
    imagemagick ghostscript qpdf 7zip
else
  echo "apt-get not found, skipping apt step"
fi

echo "== 2/3 Python venv (persistent) =="
if [ ! -x "$VENV_DIR/bin/python" ]; then
  python3 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/pip" install -q --upgrade pip
"$VENV_DIR/bin/pip" install -q \
  PyMuPDF beautifulsoup4 pypdf pdfplumber python-pptx pyarrow sqlalchemy cryptography \
  python-docx openpyxl pandas Pillow numpy pyyaml lxml qrcode

echo "== 3/3 typst + tectonic binaries (persistent, ~/.local/bin) =="
mkdir -p "$BIN_DIR" "$DL_DIR"
if [ ! -x "$BIN_DIR/typst" ]; then
  curl -fL --max-time 180 -o "$DL_DIR/typst.tar.xz" \
    "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz"
  tar -xf "$DL_DIR/typst.tar.xz" -C "$DL_DIR"
  cp "$DL_DIR/typst-x86_64-unknown-linux-musl/typst" "$BIN_DIR/typst"
  chmod +x "$BIN_DIR/typst"
fi
if [ ! -x "$BIN_DIR/tectonic" ]; then
  curl -fL --max-time 180 -o "$DL_DIR/tectonic.tar.gz" \
    "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz"
  tar -xzf "$DL_DIR/tectonic.tar.gz" -C "$BIN_DIR"
  chmod +x "$BIN_DIR/tectonic"
fi

echo "== pre-warm tectonic bundle (first compile downloads the TeX bundle, slow) =="
TMPD="$(mktemp -d)"
printf '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n' > "$TMPD/warm.tex"
(cd "$TMPD" && timeout 300 "$BIN_DIR/tectonic" -X compile warm.tex >/dev/null 2>&1 && echo "tectonic warm-up OK" || echo "tectonic warm-up skipped/failed (will retry on first real use)")
rm -rf "$TMPD"

echo "== verify =="
for t in pandoc tesseract convert gs qpdf 7z ffmpeg soffice pdftotext; do
  command -v "$t" >/dev/null && echo "$t: $(command -v "$t")" || echo "$t: MISSING"
done
"$BIN_DIR/typst" --version
"$BIN_DIR/tectonic" --version
"$VENV_DIR/bin/python" -c "import fitz, bs4, pypdf, pdfplumber, pptx, pyarrow, sqlalchemy, cryptography, docx, openpyxl, pandas, PIL, numpy, yaml, lxml; print('venv python libs: OK')"
echo "NOTE: ~/.local/bin is NOT in the default PATH; use absolute paths: $BIN_DIR/typst, $BIN_DIR/tectonic"
