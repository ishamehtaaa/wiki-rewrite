# wikidetect scoring server (CPU). Big image (~4 GB): torch + the desklib
# DeBERTa-large weights are baked in at build time so prod never downloads
# models at runtime and cold start is just the ~30s load.
FROM python:3.12-slim
WORKDIR /app

# CPU wheels only — the default PyPI torch pulls the CUDA stack, useless on a VM.
RUN pip install --no-cache-dir "torch>=2.12,<2.13" --index-url https://download.pytorch.org/whl/cpu

COPY ml/pyproject.toml ml/
COPY ml/src ml/src
RUN pip install --no-cache-dir ./ml

# Download tokenizer + weights into the HF cache now, at build time.
RUN python -c "from wikidetect.models import Scorer; Scorer('desklib')"

# Calibration (thresholds.json) is what turns a raw score into the verdict.
COPY artifacts/thresholds.json artifacts/
ENV WIKI_REWRITE_ROOT=/app \
    WIKIDETECT_HOST=0.0.0.0

EXPOSE 8756
CMD ["wikidetect", "serve"]
