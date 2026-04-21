"""
Config Router — API для управления провайдерами и стратегией в рантайме.
Позволяет переключаться между Perplexity/Ollama без перезапуска сервера.
"""

import logging
from fastapi import APIRouter, Request
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()


class StrategyUpdate(BaseModel):
    strategy: str  # auto | local | cloud | fallback | parallel


@router.get("/config/status")
async def get_status(request: Request):
    """Статус провайдеров и текущая стратегия."""
    router_svc = request.app.state.fallback_router
    ollama = request.app.state.ollama_client

    ollama_available = await ollama.is_available()
    ollama_models = await ollama.list_models() if ollama_available else []

    status = router_svc.get_status()
    status["ollama_models"] = ollama_models
    return status


@router.post("/config/strategy")
async def set_strategy(request: Request, body: StrategyUpdate):
    """Переключить стратегию маршрутизации."""
    valid = {"auto", "local", "cloud", "fallback", "parallel"}
    if body.strategy not in valid:
        return {"error": f"Invalid strategy. Valid: {valid}"}
    request.app.state.fallback_router.set_strategy(body.strategy)
    return {"ok": True, "strategy": body.strategy}


@router.get("/config/models")
async def list_models(request: Request):
    """Список доступных локальных Ollama моделей."""
    ollama = request.app.state.ollama_client
    models = await ollama.list_models()
    return {"models": models, "current": ollama.model}
