from __future__ import annotations

import argparse
import os
import sys

import uvicorn

from app.main import app


def _ensure_background_streams() -> None:
    # PyInstaller's windowed bootloader intentionally sets these to None.
    # Uvicorn still expects writable streams while configuring its logger.
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")


def main() -> None:
    _ensure_background_streams()
    parser = argparse.ArgumentParser(description="Moya bundled webnovel metadata collector")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", required=True, type=int)
    arguments = parser.parse_args()
    if arguments.host != "127.0.0.1" or not 1 <= arguments.port <= 65535:
        parser.error("the bundled collector must use a valid IPv4 loopback port")
    uvicorn.run(
        app,
        host=arguments.host,
        port=arguments.port,
        access_log=False,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
