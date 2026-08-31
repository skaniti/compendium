# Backend-only production image for apps/api (FastAPI + uvicorn).
#
# Build context is apps/api itself — root docker-compose.yml's `api`
# service points `build.context` here directly (no monorepo-root files
# needed, unlike apps/web's Dockerfile).
#
#   docker compose build api        # from the repo root
#   docker build -t compendium-api apps/api   # standalone
#
# Deliberately NOT the shape of the excluded (pre-extraction) explorer root
# Dockerfile, which bundled the Dash frontend + this FastAPI backend into one
# image driven by honcho + a Procfile (see the batch-07 extraction-inventory's
# "Docker/compose sprawl" item). This image is backend-only: no Node, no
# Claude CLI, no honcho, no frontend copy — one process (uvicorn), one job.

FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements-deploy.txt ./

# requirements-deploy.txt's own header comment says "no torch/transformers
# needed to serve" — true for what it lists explicitly (the full dev
# requirements.txt separately lists torch/transformers/accelerate/jupyter/
# etc. for the notebook + eval tooling), but NOT true transitively:
# sentence-transformers (needed for the clustering/RAG embedding path —
# backend/services/sbert_loader.py) declares torch as a hard install
# dependency, so pip pulls it in regardless of which requirements file asked
# for sentence-transformers. Left unpinned, pip resolves the default
# CUDA-bundled linux wheel (~3GB with the nvidia_* packages); this container
# never has a GPU, so pull the CPU-only build from PyTorch's own package
# index instead (~10x smaller, much faster to build, functionally identical
# for a demo-scale local embedding workload).
#
# This does NOT change whether the app boots without torch AVAILABLE at
# request time: sbert_loader.py loads the model lazily behind a
# threading-guarded singleton (get_sbert_model()); the lifespan hook does
# kick off a background encoder preload shortly after boot, and docling
# sits in main's module import graph — but /health answers before any
# model weights are needed.
# The image is simply not as torch-free as the requirements file's comment
# implies — verified by installing requirements-deploy.txt in isolation and
# inspecting site-packages (see batch-07 Task 4 results.md).
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements-deploy.txt

COPY . .
RUN chmod +x docker/entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["docker/entrypoint.sh"]
