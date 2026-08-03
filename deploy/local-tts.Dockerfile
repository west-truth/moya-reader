FROM python:3.9-slim

ARG MELOTTS_COMMIT=209145371cff8fc3bd60d7be902ea69cbdb7965a

ENV DEBIAN_FRONTEND=noninteractive \
    HF_HOME=/models/huggingface \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ffmpeg git libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/myshell-ai/MeloTTS.git /opt/MeloTTS \
    && git -C /opt/MeloTTS checkout "${MELOTTS_COMMIT}" \
    && pip install --no-cache-dir -e /opt/MeloTTS \
    && rm -rf /root/.cache/pip

RUN useradd --create-home --uid 10001 localtts \
    && mkdir -p /app /models/huggingface \
    && chown -R localtts:localtts /app /models

COPY --chown=localtts:localtts deploy/local-tts/server.py /app/server.py

USER localtts
WORKDIR /app
EXPOSE 9010

CMD ["python", "/app/server.py"]
