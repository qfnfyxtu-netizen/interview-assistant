"""
Interview Assistant — FastAPI Backend
Точка входа: WebSocket proxy для Deepgram + REST API для подсказок.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import logging

from routers.transcribe import router as transcribe_router
from routers.hints import router as hints_router
from services.keyword_extractor import KeywordExtractor
from services.perplexity_client import PerplexityClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Инициализировать сервисы при старте, освободить при завершении."""
    logger.info("Starting Interview Assistant backend...")

    # Инициализировать синглтоны
    app.state.keyword_extractor = KeywordExtractor()
    app.state.perplexity_client = PerplexityClient()

    logger.info("Services ready. Listening for connections.")
    yield

    logger.info("Shutting down...")
    await app.state.perplexity_client.close()


app = FastAPI(
    title="Interview Assistant API",
    version="1.0.0",
    description="Real-time transcription + AI hints for interviews and medical consultations",
    lifespan=lifespan,
)

# CORS — разрешить localhost и любые источники при разработке
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(transcribe_router, prefix="/ws", tags=["transcription"])
app.include_router(hints_router, prefix="/api", tags=["hints"])


@app.get("/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}


@app.get("/api/profiles")
async def list_profiles():
    """Вернуть доступные профили подсказок."""
    return {
        "profiles": [
            {"id": "medical", "name": "Медицинская консультация", "icon": "🏥"},
            {"id": "interview", "name": "Собеседование", "icon": "💼"},
            {"id": "general", "name": "Общий", "icon": "🌐"},
        ]
    }
