"""
Interview Assistant — FastAPI Backend
Точка входа: WebSocket proxy для Deepgram + REST API для подсказок.
Поддерживает dual-mode: Perplexity API (cloud) ↔ Ollama/Qwen (local).
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import logging
import os

from routers.transcribe import router as transcribe_router
from routers.hints import router as hints_router
from routers.config import router as config_router
from services.keyword_extractor import KeywordExtractor
from services.perplexity_client import PerplexityClient
from services.ollama_client import OllamaClient
from services.fallback_router import FallbackRouter

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting Interview Assistant backend...")

    # Инициализировать сервисы
    app.state.keyword_extractor = KeywordExtractor()
    app.state.perplexity_client = PerplexityClient()
    app.state.ollama_client = OllamaClient(
        base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
        model=os.getenv("OLLAMA_MODEL", "qwen2.5:7b-instruct-q4_K_M"),
        timeout=float(os.getenv("OLLAMA_TIMEOUT", "20")),
    )
    app.state.fallback_router = FallbackRouter(
        perplexity_client=app.state.perplexity_client,
        ollama_client=app.state.ollama_client,
    )

    # Проверить доступность Ollama в фоне (не блокировать старт)
    import asyncio
    asyncio.create_task(_check_ollama(app.state.ollama_client))

    logger.info(
        f"Services ready | "
        f"Perplexity: {'✓' if app.state.perplexity_client else '✗'} | "
        f"Strategy: {app.state.fallback_router._strategy}"
    )
    yield

    logger.info("Shutting down...")
    await app.state.perplexity_client.close()
    await app.state.ollama_client.close()


async def _check_ollama(ollama_client: OllamaClient):
    available = await ollama_client.is_available()
    if available:
        models = await ollama_client.list_models()
        logger.info(f"[Ollama] Available ✓ | Model: {ollama_client.model} | All: {models}")
    else:
        logger.info(
            f"[Ollama] Not available — will use Perplexity only. "
            f"To enable: install Ollama + `ollama pull {ollama_client.model}`"
        )


app = FastAPI(
    title="Interview Assistant API",
    version="2.0.0",
    description=(
        "Real-time transcription + AI hints. "
        "Dual-mode: Perplexity API (cloud) ↔ Ollama/Qwen (local, offline)"
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(transcribe_router, prefix="/ws", tags=["transcription"])
app.include_router(hints_router, prefix="/api", tags=["hints"])
app.include_router(config_router, prefix="/api", tags=["config"])


@app.get("/health")
async def health(request: "Request"):  # noqa: F821
    ollama = request.app.state.ollama_client
    return {
        "status": "ok",
        "version": "2.0.0",
        "perplexity": bool(request.app.state.perplexity_client),
        "ollama": request.app.state.ollama_client._available,
        "strategy": str(request.app.state.fallback_router._strategy),
    }


@app.get("/api/profiles")
async def list_profiles():
    return {
        "profiles": [
            {"id": "medical", "name": "Медицинская консультация", "icon": "🏥"},
            {"id": "interview", "name": "Собеседование", "icon": "💼"},
            {"id": "general", "name": "Общий", "icon": "🌐"},
        ]
    }
