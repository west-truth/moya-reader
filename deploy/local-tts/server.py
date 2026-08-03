from __future__ import annotations

import json
import os
import signal
import subprocess
import tempfile
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from melo.api import TTS


HOST = "0.0.0.0"
PORT = int(os.getenv("PORT", "9010"))
LANGUAGE = os.getenv("MELOTTS_LANGUAGE", "KR").strip().upper() or "KR"
DEVICE = os.getenv("MELOTTS_DEVICE", "cpu").strip() or "cpu"
MODEL_ID = os.getenv("MELOTTS_MODEL_ID", "melotts-korean").strip() or "melotts-korean"
MAX_TEXT_CHARACTERS = int(os.getenv("MELOTTS_MAX_TEXT_CHARACTERS", "20000"))
MAX_REQUEST_BYTES = max(64 * 1024, MAX_TEXT_CHARACTERS * 8)
SUPPORTED_FORMATS = {"wav", "mp3", "ogg", "flac"}


print(json.dumps({"event": "local_tts_model_loading", "language": LANGUAGE, "device": DEVICE}))
MODEL = TTS(language=LANGUAGE, device=DEVICE)
SPEAKER_IDS = {str(key): int(value) for key, value in MODEL.hps.data.spk2id.items()}
DEFAULT_VOICE_ID = next(iter(SPEAKER_IDS))
INFERENCE_LOCK = threading.Lock()
print(
    json.dumps(
        {
            "event": "local_tts_model_ready",
            "modelId": MODEL_ID,
            "language": LANGUAGE,
            "voices": list(SPEAKER_IDS),
        }
    )
)


def response_json(handler: BaseHTTPRequestHandler, status: HTTPStatus, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status.value)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def request_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    content_length = int(handler.headers.get("Content-Length", "0"))
    if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
        raise ValueError("request_size_invalid")
    value = json.loads(handler.rfile.read(content_length))
    if not isinstance(value, dict):
        raise ValueError("request_body_invalid")
    return value


def requested_voice(payload: dict[str, Any]) -> str:
    voice_id = payload.get("voiceId")
    if not isinstance(voice_id, str) or not voice_id.strip():
        profile = payload.get("voiceProfile")
        if isinstance(profile, dict):
            voice_id = profile.get("providerVoiceId")
    candidate = voice_id.strip() if isinstance(voice_id, str) else DEFAULT_VOICE_ID
    if candidate not in SPEAKER_IDS:
        raise ValueError("voice_not_found")
    return candidate


def requested_speed(payload: dict[str, Any]) -> float:
    value = payload.get("speed", 1.0)
    if not isinstance(value, (int, float)):
        raise ValueError("speed_invalid")
    return min(2.0, max(0.5, float(value)))


def requested_format(payload: dict[str, Any]) -> str:
    value = payload.get("format", "wav")
    candidate = value.strip().lower() if isinstance(value, str) else "wav"
    if candidate not in SUPPORTED_FORMATS:
        raise ValueError("format_not_supported")
    return candidate


def synthesize(payload: dict[str, Any]) -> tuple[bytes, str]:
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("text_required")
    if len(text) > MAX_TEXT_CHARACTERS:
        raise ValueError("text_too_long")
    requested_model = payload.get("modelId")
    if isinstance(requested_model, str) and requested_model.strip() and requested_model.strip() != MODEL_ID:
        raise ValueError("model_not_available")

    voice_id = requested_voice(payload)
    speed = requested_speed(payload)
    output_format = requested_format(payload)
    with tempfile.TemporaryDirectory(prefix="noveldesk-tts-") as directory:
        wav_path = Path(directory) / "speech.wav"
        with INFERENCE_LOCK:
            MODEL.tts_to_file(
                text=text.strip(),
                speaker_id=SPEAKER_IDS[voice_id],
                output_path=str(wav_path),
                speed=speed,
                quiet=True,
            )
        if output_format == "wav":
            return wav_path.read_bytes(), "audio/wav"

        output_path = Path(directory) / f"speech.{output_format}"
        subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(wav_path),
                str(output_path),
            ],
            check=True,
            timeout=120,
        )
        content_type = {
            "mp3": "audio/mpeg",
            "ogg": "audio/ogg",
            "flac": "audio/flac",
        }[output_format]
        return output_path.read_bytes(), content_type


class LocalTTSHandler(BaseHTTPRequestHandler):
    server_version = "MoyaLocalTTS/1"

    def log_message(self, format_string: str, *args: Any) -> None:
        print(json.dumps({"event": "local_tts_http", "message": format_string % args}))

    def do_GET(self) -> None:
        if self.path == "/health":
            response_json(self, HTTPStatus.OK, {"ok": True, "modelId": MODEL_ID, "language": LANGUAGE})
            return
        if self.path == "/voices":
            response_json(
                self,
                HTTPStatus.OK,
                {
                    "voices": [
                        {"id": voice_id, "label": voice_id, "lang": "ko-KR" if LANGUAGE == "KR" else LANGUAGE}
                        for voice_id in SPEAKER_IDS
                    ]
                },
            )
            return
        response_json(self, HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/synthesize":
            response_json(self, HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        try:
            audio, content_type = synthesize(request_json(self))
        except (ValueError, json.JSONDecodeError) as error:
            response_json(self, HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            print(json.dumps({"event": "local_tts_synthesis_failed", "errorType": type(error).__name__}))
            response_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "synthesis_failed"})
            return

        self.send_response(HTTPStatus.OK.value)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("X-TTS-Model-Id", MODEL_ID)
        self.end_headers()
        self.wfile.write(audio)


class LocalTTSServer(ThreadingHTTPServer):
    daemon_threads = True


SERVER = LocalTTSServer((HOST, PORT), LocalTTSHandler)


def stop_server(_signal_number: int, _frame: Any) -> None:
    threading.Thread(target=SERVER.shutdown, daemon=True).start()


signal.signal(signal.SIGTERM, stop_server)
signal.signal(signal.SIGINT, stop_server)
print(json.dumps({"event": "local_tts_listening", "host": HOST, "port": PORT}))
SERVER.serve_forever(poll_interval=0.5)
SERVER.server_close()
