"""
Hints Router — основной API для получения подсказок.
POST /api/hints → ключевые слова → FallbackRouter (Perplexity|Ollama) → приоритизация → ответ.
"""

import logging
from fastapi import APIRouter, Request, HTTPException
from models.schemas import HintsRequest, HintsResponse, HintItem
from services.priority_engine import PriorityEngine

logger = logging.getLogger(__name__)
router = APIRouter()
priority_engine = PriorityEngine()

# Иконки провайдеров для UI
PROVIDER_ICONS = {
    "perplexity": "🌐",
    "ollama": "🖥",
    "none": "⚠️",
}


@router.post("/hints", response_model=HintsResponse)
async def get_hints(request: Request, body: HintsRequest):
    keyword_extractor = request.app.state.keyword_extractor
    fallback_router = request.app.state.fallback_router

    if not body.text or len(body.text.strip()) < 5:
        return HintsResponse(keywords=[], hints=[])

    try:
        # 1. Извлечь ключевые слова
        keywords = keyword_extractor.extract(body.text, profile=body.profile)
        logger.info(f"[Hints] Keywords: {keywords} | profile={body.profile}")

        if not keywords:
            return HintsResponse(keywords=[], hints=[])

        # 2. Запросить через FallbackRouter (max 2 ключевых слова)
        top_keywords = keywords[:2]
        raw_hints = []

        for kw in top_keywords:
            content, provider = await fallback_router.query(
                keyword=kw,
                context=body.text,
                profile=body.profile,
            )
            if content:
                raw_hints.append({
                    "keyword": kw,
                    "content": content,
                    "provider": provider,
                })
                logger.info(f"[Hints] '{kw}' → answered by {provider}")

        # 3. Приоритизировать и добавить метку провайдера
        prioritized = priority_engine.prioritize(raw_hints, profile=body.profile)

        # Добавить провайдер в source для отображения в UI
        for i, hint in enumerate(prioritized):
            provider = raw_hints[i]["provider"] if i < len(raw_hints) else "unknown"
            icon = PROVIDER_ICONS.get(provider, "")
            hint.source = f"{icon} {hint.source} [{provider}]"

        return HintsResponse(keywords=keywords, hints=prioritized)

    except Exception as e:
        logger.error(f"[Hints] Error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
