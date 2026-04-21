"""
Ollama Local LLM Client
Async клиент для Qwen (и любых других моделей) через локальный Ollama сервер.

Оптимизирован под RTX 5050 8GB VRAM:
  - qwen2.5:7b-instruct-q4_K_M  (~4.5 GB VRAM) ← рекомендуется для скорости
  - qwen2.5:14b-instruct-q4_K_M (~8 GB VRAM)   ← максимальное качество
  - qwen3:8b-q4_K_M              (~5 GB VRAM)   ← qwen3 если установлен

Установка: https://ollama.com → `ollama pull qwen2.5:7b-instruct-q4_K_M`
"""

import asyncio
import json
import logging
import time
import httpx

logger = logging.getLogger(__name__)

# Системные промпты по профилям — оптимизированы для медицинского Qwen
OLLAMA_SYSTEM_PROMPTS = {
    "medical": """Ты — медицинский ИИ-ассистент, работающий локально на устройстве врача.
Специализация: ревматология, внутренние болезни, психиатрия (РФ, клинические рекомендации).

Правила ответа:
- МАКСИМУМ 3–4 предложения. Краткость критична — врач читает во время приёма.
- Структура: [Ключевой факт] → [Дозировка/критерий если применимо] → [Предупреждение если есть].
- Используй принятые в РФ МНН и дозировки (мг/кг, мг/нед, мг/сут).
- При упоминании биологиков — уточни линию терапии и скрининг перед назначением.
- Ссылайся на КР РФ, EULAR, ACR когда уместно.
- Язык: русский, медицинская терминология.
- НЕ давай юридических советов. Это поддержка клинического решения.""",

    "interview": """Ты — коуч по профессиональным собеседованиям для врача (ревматолог/психиатр).
Правила ответа:
- МАКСИМУМ 3 предложения с конкретной тактикой.
- Для поведенческих вопросов — напомни структуру STAR (Ситуация→Задача→Действие→Результат).
- Для клинических вопросов — подскажи ключевые термины и алгоритм ответа.
- Язык: русский.""",

    "general": """Ты — умный ассистент. Отвечай кратко (2–3 предложения), точно, на русском языке.""",
}

# Параметры генерации — баланс скорость/качество для RTX 5050
OLLAMA_OPTIONS = {
    "temperature": 0.15,        # низкая температура для медицины = меньше галлюцинаций
    "top_p": 0.9,
    "num_predict": 256,         # ~3–4 предложения
    "num_ctx": 4096,            # контекстное окно
    "repeat_penalty": 1.1,
}


class OllamaClient:
    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        model: str = "qwen2.5:7b-instruct-q4_K_M",
        timeout: float = 20.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self._client = httpx.AsyncClient(timeout=timeout)
        self._available: bool | None = None  # None = не проверено

    # ──────────────────────────────────────────────
    # Public API
    # ──────────────────────────────────────────────

    async def is_available(self) -> bool:
        """Проверить доступность Ollama сервера и наличие модели."""
        try:
            resp = await self._client.get(f"{self.base_url}/api/tags", timeout=3.0)
            if resp.status_code != 200:
                self._available = False
                return False
            models = [m["name"] for m in resp.json().get("models", [])]
            # Проверить точное совпадение или совпадение по базовому имени
            base_name = self.model.split(":")[0]
            self._available = any(
                self.model in m or base_name in m
                for m in models
            )
            if not self._available:
                logger.warning(
                    f"[Ollama] Model '{self.model}' not found. "
                    f"Available: {models}. "
                    f"Run: ollama pull {self.model}"
                )
            return self._available
        except Exception as e:
            logger.debug(f"[Ollama] Not available: {e}")
            self._available = False
            return False

    async def query(
        self,
        keyword: str,
        context: str = "",
        profile: str = "general",
    ) -> str | None:
        """
        Запросить локальную модель. Возвращает текст ответа или None.
        """
        system = OLLAMA_SYSTEM_PROMPTS.get(profile, OLLAMA_SYSTEM_PROMPTS["general"])

        if context and len(context) > 20:
            context_short = context[-400:] if len(context) > 400 else context
            user_msg = f"Контекст консультации: «{context_short}»\n\nТребуется информация по: {keyword}"
        else:
            user_msg = keyword

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user_msg},
            ],
            "stream": False,
            "options": OLLAMA_OPTIONS,
        }

        t0 = time.perf_counter()
        try:
            resp = await self._client.post(
                f"{self.base_url}/api/chat",
                json=payload,
                timeout=self.timeout,
            )
            resp.raise_for_status()
            data = resp.json()
            content = data["message"]["content"].strip()
            elapsed = time.perf_counter() - t0
            logger.info(
                f"[Ollama] '{keyword[:40]}' → {len(content)} chars in {elapsed:.1f}s "
                f"(model={self.model})"
            )
            return content

        except httpx.TimeoutException:
            logger.warning(f"[Ollama] Timeout after {self.timeout}s for '{keyword[:40]}'")
            return None
        except Exception as e:
            logger.error(f"[Ollama] Error: {e}")
            return None

    async def list_models(self) -> list[str]:
        """Вернуть список установленных моделей."""
        try:
            resp = await self._client.get(f"{self.base_url}/api/tags", timeout=5.0)
            return [m["name"] for m in resp.json().get("models", [])]
        except Exception:
            return []

    async def close(self):
        await self._client.aclose()
