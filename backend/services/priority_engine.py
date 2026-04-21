"""
Priority Engine
Оценивает критичность подсказок и присваивает приоритет:
  critical — немедленное внимание (противопоказания, безопасность)
  high     — важная клиническая/профессиональная информация
  medium   — полезный контекст
  low      — фоновая информация
"""

import re
import logging
from models.schemas import HintItem

logger = logging.getLogger(__name__)

# Маркеры критичности
CRITICAL_PATTERNS = [
    r"противопоказан", r"противопоказано", r"запрещён", r"не применять",
    r"летальн", r"тяжёл.{0,20}(побочн|осложнен)",
    r"немедленно", r"экстренн", r"анафилак",
    r"не (рекомендуется|следует) совмещать",
]

HIGH_PATTERNS = [
    r"дозировк", r"доза", r"мг/", r"мкг",
    r"критерии?", r"диагноз", r"лечение",
    r"мониторинг", r"контроль", r"анализ",
    r"побочн", r"нежелательн",
    r"(star|ситуация|действие|результат)",  # interview
]

LOW_PATTERNS = [
    r"история", r"описан в", r"также известн", r"впервые",
    r"по данным", r"исследовани",
]

# Источники — добавляем к подсказке
TRUSTED_SOURCES = {
    "medical": "КР РФ / ACR / EULAR Guidelines",
    "interview": "Career Coaching Best Practices",
    "general": "Perplexity AI",
}


class PriorityEngine:
    def __init__(self):
        self._critical_re = re.compile("|".join(CRITICAL_PATTERNS), re.IGNORECASE)
        self._high_re = re.compile("|".join(HIGH_PATTERNS), re.IGNORECASE)
        self._low_re = re.compile("|".join(LOW_PATTERNS), re.IGNORECASE)

    def prioritize(
        self,
        raw_hints: list[dict],
        profile: str = "general",
    ) -> list[HintItem]:
        """
        Принять список {keyword, content} → вернуть List[HintItem] с приоритетами.
        """
        results = []

        for item in raw_hints:
            keyword = item.get("keyword", "")
            content = item.get("content", "")

            if not content:
                continue

            priority = self._score_priority(content)
            source = TRUSTED_SOURCES.get(profile, "Perplexity AI")

            results.append(HintItem(
                text=content,
                priority=priority,
                source=source,
                query=keyword,
            ))

        # Сортировать: critical → high → medium → low
        order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
        results.sort(key=lambda h: order.get(h.priority, 2))

        return results

    def _score_priority(self, text: str) -> str:
        """Оценить приоритет по паттернам в тексте."""
        if self._critical_re.search(text):
            return "critical"
        if self._high_re.search(text):
            return "high"
        if self._low_re.search(text):
            return "low"
        return "medium"
