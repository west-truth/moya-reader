FROM python:3.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    MOYA_COLLECTOR_DATA_DIR=/data

WORKDIR /app

COPY services/webnovel-metadata-collector/pyproject.toml ./pyproject.toml
COPY services/webnovel-metadata-collector/app ./app
RUN pip install --no-cache-dir '.[auth]' \
    && python -m playwright install --with-deps --no-shell chromium \
    && apt-get install --yes --no-install-recommends xauth \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --home-dir /data --shell /usr/sbin/nologin collector \
    && chown -R collector:collector /data

COPY LICENSE THIRD_PARTY_NOTICES.md /licenses/

USER collector
EXPOSE 8000

CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & export DISPLAY=:99; exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-access-log --log-level warning"]
