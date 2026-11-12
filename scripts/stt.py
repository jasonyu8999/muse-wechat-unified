#!/usr/bin/env python3
"""本地语音转文字（faster-whisper），供微信 worker 调用。

用法：stt.py <音频路径> [--model tiny]
- 音频先经 ffmpeg 转 16k 单声道 PCM（不依赖 PyAV，绕过 av 版本问题），
  再以 numpy float32 数组喂给 faster-whisper。
- 输出：转写文字（每行一段）；无语音时输出空行并 exit 0。
- 模型默认 tiny（中文够用、快）；首次运行会从 HF 下载模型到 ~/.cache/huggingface。
"""
import argparse
import subprocess
import sys

import numpy as np


def decode_pcm(path: str, sr: int = 16000) -> np.ndarray:
    cmd = [
        "ffmpeg", "-v", "error", "-i", path,
        "-ar", str(sr), "-ac", "1", "-f", "s16le", "-",
    ]
    p = subprocess.run(cmd, capture_output=True, timeout=600)
    if p.returncode != 0:
        raise RuntimeError("ffmpeg 解码失败: " + p.stderr.decode(errors="replace")[:300])
    pcm = np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    return pcm


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--model", default="tiny")
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    pcm = decode_pcm(args.audio)
    if pcm.size == 0:
        print("")
        return 0
    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    segments, info = model.transcribe(pcm, language="zh")
    texts = [s.text.strip() for s in segments if s.text.strip()]
    print("\n".join(texts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
