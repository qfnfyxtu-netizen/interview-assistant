#!/usr/bin/env python3
"""
Zoom Interview Assistant — FastAPI backend
- /api/config          : returns runtime config
- /api/hint            : POST transcript → Perplexity → hint
- /ws/deepgram         : WebSocket proxy to Deepgram streaming STT
- /api/tts             : POST text → ElevenLabs TTS audio (optional)
"""
import asyncio
import json
import logging
import os
import httpx

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from anthropic import Anthropic

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Zoom Interview Assistant API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Env ──────────────────────────────────────────────────────────────────────
DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "")
PERPLEXITY_API_KEY = os.environ.get("PERPLEXITY_API_KEY", "")
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")

# Perplexity endpoint
PPLX_URL = "https://api.perplexity.ai/chat/completions"

# ── Models ────────────────────────────────────────────────────────────────────
class HintRequest(BaseModel):
    transcript: str
    mode: str = "interview"  # "interview" | "compass"
    language: str = "ru"

class TTSRequest(BaseModel):
    text: str
    voice_id: str = "EXAVITQu4vr4xnSDxMaL"  # ElevenLabs "Bella"

# ── System prompts ────────────────────────────────────────────────────────────
SYSTEM_PROMPTS = {
    "interview": """Ты — скрытый ИИ-ассистент врача-ревматолога на собеседовании.
Слушаешь речь интервьюера и даёшь КРАТКИЕ (1-3 предложения) чёткие подсказки:
- конкретные медицинские факты и цифры для ответа
- ключевые термины и протоколы
- структуру идеального ответа
Будь лаконичен. Отвечай на том языке, на котором задан вопрос. JSON: {"hint": "...", "keywords": ["...", "..."]}""",

    "compass": """Ты — навигационный компас для врача на собеседовании по ревматологии.
На основе транскрипта определи:
- О чём идёт речь (тема)
- Самый важный следующий шаг / ответ
- Риски (если есть ловушка в вопросе)
Отвечай СТРОГО в JSON: {"topic": "...", "compass": "...", "risk": "...", "keywords": ["..."]}"""
}

# ── Routes ───────────────────────────────────────────────────────────────────

@app.get("/api/config")
def get_config():
    return {
        "deepgram_available": bool(DEEPGRAM_API_KEY),
        "perplexity_available": bool(PERPLEXITY_API_KEY),
        "tts_available": bool(ELEVENLABS_API_KEY),
        "version": "1.0.0"
    }


@app.post("/api/hint")
async def generate_hint(req: HintRequest):
    """Generate interview hint from transcript using Perplexity or Claude fallback."""
    if not req.transcript.strip():
        return JSONResponse({"hint": "", "keywords": []})

    system = SYSTEM_PROMPTS.get(req.mode, SYSTEM_PROMPTS["interview"])

    # Try Perplexity first (sonar-pro has live web search)
    if PERPLEXITY_API_KEY:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    PPLX_URL,
                    headers={
                        "Authorization": f"Bearer {PERPLEXITY_API_KEY}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "model": "sonar",
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": f"Транскрипт собеседника: {req.transcript}"}
                        ],
                        "max_tokens": 300,
                        "temperature": 0.3
                    }
                )
                if resp.status_code == 200:
                    data = resp.json()
                    content = data["choices"][0]["message"]["content"]
                    # Try to parse JSON from response
                    try:
                        # Extract JSON block if wrapped in markdown
                        if "```" in content:
                            import re
                            m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", content, re.DOTALL)
                            if m:
                                content = m.group(1)
                        parsed = json.loads(content)
                        return JSONResponse(parsed)
                    except Exception:
                        return JSONResponse({"hint": content.strip(), "keywords": []})
        except Exception as e:
            logger.warning(f"Perplexity API error: {e}, falling back to Claude")

    # Fallback: Claude via Anthropic SDK
    try:
        client = Anthropic()
        message = client.messages.create(
            model="claude_sonnet_4_6",
            max_tokens=300,
            system=system,
            messages=[{"role": "user", "content": f"Транскрипт собеседника: {req.transcript}"}]
        )
        content = message.content[0].text
        try:
            if "```" in content:
                import re
                m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", content, re.DOTALL)
                if m:
                    content = m.group(1)
            parsed = json.loads(content)
            return JSONResponse(parsed)
        except Exception:
            return JSONResponse({"hint": content.strip(), "keywords": []})
    except Exception as e:
        logger.error(f"Claude fallback error: {e}")
        return JSONResponse({"hint": "Ошибка генерации подсказки", "keywords": []}, status_code=400)


@app.websocket("/ws/deepgram")
async def deepgram_proxy(ws: WebSocket):
    """
    WebSocket proxy: браузер → этот WS → Deepgram Streaming STT
    Поддерживает двунаправленный поток: аудио bytes → transcript JSON
    """
    await ws.accept()
    logger.info("Client connected to Deepgram proxy")

    if not DEEPGRAM_API_KEY:
        await ws.send_json({"type": "error", "message": "DEEPGRAM_API_KEY not set"})
        await ws.close()
        return

    # Deepgram streaming URL
    dg_url = (
        "wss://api.deepgram.com/v1/listen"
        "?model=nova-2"
        "&language=ru"
        "&punctuate=true"
        "&interim_results=true"
        "&utterance_end_ms=1500"
        "&vad_events=true"
        "&encoding=linear16"
        "&sample_rate=16000"
    )

    import websockets as ws_lib

    try:
        async with ws_lib.connect(
            dg_url,
            extra_headers={"Authorization": f"Token {DEEPGRAM_API_KEY}"},
            ping_interval=10,
            ping_timeout=20,
        ) as dg_ws:
            logger.info("Connected to Deepgram")

            async def recv_from_deepgram():
                """Forward Deepgram responses to client."""
                try:
                    async for msg in dg_ws:
                        if isinstance(msg, bytes):
                            continue
                        try:
                            data = json.loads(msg)
                            # Forward transcript events
                            if data.get("type") == "Results":
                                alt = data.get("channel", {}).get("alternatives", [{}])[0]
                                transcript = alt.get("transcript", "")
                                is_final = data.get("is_final", False)
                                if transcript:
                                    await ws.send_json({
                                        "type": "transcript",
                                        "text": transcript,
                                        "is_final": is_final
                                    })
                            elif data.get("type") == "UtteranceEnd":
                                await ws.send_json({"type": "utterance_end"})
                        except Exception as e:
                            logger.warning(f"Parse error: {e}")
                except Exception as e:
                    logger.warning(f"Deepgram recv error: {e}")

            async def send_to_deepgram():
                """Forward audio bytes from client to Deepgram."""
                try:
                    while True:
                        data = await ws.receive()
                        if "bytes" in data:
                            await dg_ws.send(data["bytes"])
                        elif "text" in data:
                            # Control messages (keepalive, close, config)
                            ctrl = json.loads(data["text"])
                            if ctrl.get("type") == "CloseStream":
                                await dg_ws.send(json.dumps({"type": "CloseStream"}))
                                break
                except WebSocketDisconnect:
                    logger.info("Client disconnected")
                except Exception as e:
                    logger.warning(f"Send to Deepgram error: {e}")

            await asyncio.gather(recv_from_deepgram(), send_to_deepgram())

    except Exception as e:
        logger.error(f"Deepgram connection error: {e}")
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        logger.info("Deepgram proxy closed")


@app.post("/api/tts")
async def text_to_speech(req: TTSRequest):
    """ElevenLabs TTS — returns audio/mpeg stream."""
    if not ELEVENLABS_API_KEY:
        return JSONResponse({"error": "ElevenLabs API key not configured"}, status_code=400)

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{req.voice_id}/stream"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
    }
    body = {
        "text": req.text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.8}
    }

    async def audio_stream():
        async with httpx.AsyncClient(timeout=30.0) as client:
            async with client.stream("POST", url, headers=headers, json=body) as resp:
                async for chunk in resp.aiter_bytes(1024):
                    yield chunk

    return StreamingResponse(audio_stream(), media_type="audio/mpeg")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
