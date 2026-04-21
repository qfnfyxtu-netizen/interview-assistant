"""
WebSocket Proxy для Deepgram.
Браузер → наш WS → Deepgram Nova-2 API → назад браузеру.
Это нужно чтобы API-ключ Deepgram не светился в frontend-коде.
"""

import asyncio
import json
import os
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
import websockets

logger = logging.getLogger(__name__)
router = APIRouter()

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "")

# Параметры Deepgram для медицины/интервью — Nova-2 с диаризацией
DEEPGRAM_WS_BASE = "wss://api.deepgram.com/v1/listen"

PROFILES_PARAMS = {
    "medical": {
        "model": "nova-2-medical",
        "language": "ru",
        "diarize": "true",
        "punctuate": "true",
        "smart_format": "true",
        "utterance_end_ms": "1200",
        "interim_results": "true",
        "endpointing": "400",
    },
    "interview": {
        "model": "nova-2",
        "language": "ru",
        "diarize": "true",
        "punctuate": "true",
        "smart_format": "true",
        "utterance_end_ms": "1000",
        "interim_results": "true",
        "endpointing": "300",
    },
    "general": {
        "model": "nova-2",
        "language": "ru",
        "diarize": "true",
        "punctuate": "true",
        "smart_format": "true",
        "interim_results": "true",
        "endpointing": "400",
    },
}


def _build_dg_url(profile: str) -> str:
    params = PROFILES_PARAMS.get(profile, PROFILES_PARAMS["general"])
    # Добавить common params
    params["encoding"] = "linear16"
    params["sample_rate"] = "16000"
    params["channels"] = "1"
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return f"{DEEPGRAM_WS_BASE}?{query}"


@router.websocket("/transcribe")
async def transcribe_ws(
    websocket: WebSocket,
    profile: str = Query(default="general"),
):
    """
    WebSocket endpoint: получает бинарное аудио (LINEAR16 PCM)
    и проксирует в Deepgram, возвращая транскрипты клиенту.
    """
    await websocket.accept()
    logger.info(f"[Transcribe] Client connected, profile={profile}")

    if not DEEPGRAM_API_KEY:
        await websocket.send_json({"type": "error", "message": "DEEPGRAM_API_KEY не задан"})
        await websocket.close(1008)
        return

    dg_url = _build_dg_url(profile)

    try:
        async with websockets.connect(
            dg_url,
            additional_headers={"Authorization": f"Token {DEEPGRAM_API_KEY}"},
            ping_interval=10,
            ping_timeout=20,
        ) as dg_ws:
            logger.info(f"[Transcribe] Connected to Deepgram ({profile})")

            async def recv_from_client():
                """Читать аудио из браузера → слать в Deepgram."""
                try:
                    while True:
                        data = await websocket.receive_bytes()
                        await dg_ws.send(data)
                except WebSocketDisconnect:
                    logger.info("[Transcribe] Client disconnected")
                except Exception as e:
                    logger.error(f"[Transcribe] recv_from_client error: {e}")

            async def recv_from_deepgram():
                """Читать транскрипты из Deepgram → слать браузеру."""
                try:
                    async for message in dg_ws:
                        data = json.loads(message)
                        await websocket.send_json(data)
                except websockets.ConnectionClosed:
                    logger.info("[Transcribe] Deepgram closed connection")
                except Exception as e:
                    logger.error(f"[Transcribe] recv_from_deepgram error: {e}")

            # Запустить оба потока конкурентно
            await asyncio.gather(recv_from_client(), recv_from_deepgram())

    except Exception as e:
        logger.error(f"[Transcribe] Connection error: {e}")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        logger.info("[Transcribe] Session ended")
