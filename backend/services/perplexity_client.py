"""
Perplexity API Client
Асинхронные запросы к Perplexity API для получения фактической информации.
Использует модель sonar для быстрых ответов с источниками.
"""

import os
import asyncio
import logging
import json
import httpx

logger = logging.getLogger(__name__)

PERPLEXITY_API_KEY = os.getenv("PERPLEXITY_API_KEY", "")
PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions"

# Системные промпты по профилям
SYSTEM_PROMPTS = {
    "medical": """Ты — медицинский ИИ-ассистент для врача на консультации.
Отвечай КРАТКО (2-4 предложения), ТОЛЬКО по делу.
Формат ответа:
- Ключевой факт или рекомендация
- Дозировка/критерий/ссылка если применимо
- Предупреждение если есть важное противопоказание

Язык: русский. Источники: клинические рекомендации РФ, ACR/EULAR guidelines.
Не давай юридических советов. Это поддержка принятия решений, не замена клинического суждения.""",

    "interview": """Ты — коуч по собеседованиям для врача.
Отвечай КРАТКО (2-3 предложения) с конкретной подсказкой.
Формат:
- Как лучше ответить на этот вопрос
- Ключевые слова/структура (STAR если поведенческий)
- Что НЕ говорить

Язык: русский. Будь практичным и конкретным.""",

    "general": """Ты — умный ассистент. Дай краткий и точный ответ (2-3 предложения).
Факты должны быть актуальными. Укажи источник если возможно. Язык: русский.""",
}


class PerplexityClient:
    def __init__(self):
        self._client = httpx.AsyncClient(timeout=15.0)
        self._semaphore = asyncio.Semaphore(3)  # Не более 3 параллельных запросов

    async def query(
        self,
        keyword: str,
        context: str = "",
        profile: str = "general",
    ) -> str | None:
        """
        Запросить Perplexity API по ключевому слову с контекстом.
        Возвращает строку с ответом или None при ошибке.
        """
        if not PERPLEXITY_API_KEY:
            logger.warning("[Perplexity] API key not set")
            return self._mock_response(keyword, profile)

        system_prompt = SYSTEM_PROMPTS.get(profile, SYSTEM_PROMPTS["general"])

        # Формируем контекстный запрос
        if context and len(context) > 20:
            # Обрезать контекст до последних 300 символов
            context_short = context[-300:] if len(context) > 300 else context
            user_message = f"Контекст разговора: «{context_short}»\n\nВопрос/термин для поиска: {keyword}"
        else:
            user_message = keyword

        payload = {
            "model": "llama-3.1-sonar-small-128k-online",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            "max_tokens": 300,
            "temperature": 0.2,
            "return_citations": True,
            "return_related_questions": False,
            "search_recency_filter": "year",
        }

        async with self._semaphore:
            try:
                resp = await self._client.post(
                    PERPLEXITY_API_URL,
                    headers={
                        "Authorization": f"Bearer {PERPLEXITY_API_KEY}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
                resp.raise_for_status()
                data = resp.json()

                content = data["choices"][0]["message"]["content"]
                logger.info(f"[Perplexity] Got response for '{keyword}' ({len(content)} chars)")
                return content

            except httpx.HTTPStatusError as e:
                logger.error(f"[Perplexity] HTTP error {e.response.status_code}: {e.response.text}")
                return None
            except Exception as e:
                logger.error(f"[Perplexity] Error: {e}")
                return None

    def _mock_response(self, keyword: str, profile: str) -> str:
        """Заглушка для тестирования без API-ключа."""
        mock_data = {
            "medical": {
                "метотрексат": "Метотрексат — базисный БПВП при РА. Стандартная доза: 7.5–25 мг/нед п/к или внутрь. Обязательно: фолиевая кислота 5 мг/нед. Мониторинг: ОАК, АЛТ, АСТ, креатинин каждые 1–3 мес. Противопоказан при беременности, тяжёлой почечной недостаточности.",
                "das28": "DAS28 — индекс активности РА. <2.6 = ремиссия, 2.6–3.2 = низкая, 3.2–5.1 = умеренная, >5.1 = высокая активность. Включает: СОЭ или СРБ + счёт болезненных/припухших суставов (28) + ВАШ пациента.",
            },
            "interview": {
                "расскажите о себе": "Структура: 1) текущая должность и опыт (30 сек) 2) ключевые достижения (30 сек) 3) почему эта вакансия (20 сек). Начните с профессиональной роли, не с биографии. Акцент на специализации и уникальном опыте.",
            },
        }
        profile_data = mock_data.get(profile, {})
        for k, v in profile_data.items():
            if k.lower() in keyword.lower():
                return v
        return f"[Тест] Информация по теме «{keyword}» (API-ключ не задан — используется заглушка)"

    async def close(self):
        await self._client.aclose()
