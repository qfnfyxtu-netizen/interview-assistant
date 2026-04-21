"""
Hints Router — основной API для получения подсказок.
POST /api/hints → извлечь ключевые слова → Perplexity → приоритизировать → вернуть.
"""

import logging
from fastapi import APIRouter, Request, HTTPException
from models.schemas import HintsRequest, HintsResponse
from services.priority_engine import PriorityEngine

logger = logging.getLogger(__name__)
router = APIRouter()
priority_engine = PriorityEngine()


@router.post("/hints", response_model=HintsResponse)
async def get_hints(request: Request, body: HintsRequest):
    """
    Принять транскрипт текста, вернуть приоритизированные подсказки.
    """
    keyword_extractor = request.app.state.keyword_extractor
    perplexity_client = request.app.state.perplexity_client

    if not body.text or len(body.text.strip()) < 5:
        return HintsResponse(keywords=[], hints=[])

    try:
        # 1. Извлечь ключевые слова
        keywords = keyword_extractor.extract(body.text, profile=body.profile)
        logger.info(f"[Hints] Keywords: {keywords}")

        if not keywords:
            return HintsResponse(keywords=[], hints=[])

        # 2. Запросить Perplexity по наиболее значимым ключевым словам
        # Ограничиваем до 2 запросов для быстрого ответа
        top_keywords = keywords[:2]
        raw_hints = []

        for kw in top_keywords:
            hint = await perplexity_client.query(
                keyword=kw,
                context=body.text,
                profile=body.profile,
            )
            if hint:
                raw_hints.append({"keyword": kw, "content": hint})

        # 3. Приоритизировать
        prioritized = priority_engine.prioritize(raw_hints, profile=body.profile)

        return HintsResponse(keywords=keywords, hints=prioritized)

    except Exception as e:
        logger.error(f"[Hints] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
