# PDF 抽出ワーカーの実行環境。
#
# この machine では Windows の Smart App Control（Enforce）が torch などの未署名
# ネイティブライブラリの読み込みを拒否するため、Docling を Windows のローカル venv
# では動かせない。抽出だけをコンテナへ閉じ込め、サーバーとの境界は従来どおり
# 「stdout に JSON 一件」に保つ。
#
# 実行時はネットワークを切って使う（`--network none`）。モデルはビルド時に取得して
# イメージへ焼き込み、実行時は取りに行かない。
FROM python:3.13-slim

# opencv / docling-parse が要求する共有ライブラリだけを入れる。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# GPU は Ollama が使うので、抽出は CPU 版 torch に固定する（イメージも小さくなる）。
RUN pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        torch torchvision

WORKDIR /app

# 初回は requirements.in から解決し、固定後は lock を使う。
ARG REQUIREMENTS=requirements.in
COPY requirements.in requirements.lock.tx[t] ./
RUN pip install --no-cache-dir -r "${REQUIREMENTS}"

# レイアウト・表構造モデルをビルド時に取得する。実行時は取りに行かない。
ENV DOCLING_ARTIFACTS_PATH=/models
RUN python -c "from pathlib import Path; from docling.utils.model_downloader import download_models; download_models(output_dir=Path('/models'), progress=False)"

COPY pdf_ja /app/pdf_ja

ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    OMP_NUM_THREADS=4

ENTRYPOINT ["python", "-m", "pdf_ja.worker"]
