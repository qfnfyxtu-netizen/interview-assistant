"""
Fallback Router
Управляет переключением между облачным (Perplexity) и локальным (Ollama/Qwen) провайдерами.

Стратегии:
  auto     — Perplexity если доступен, иначе Ollama (по умолчанию)
  local    — только Ollama, без обращений в интернет
  cloud    — только Perplexity
  parallel — оба параллельно, быстрейший выигрывает (дорого по API)
  fallback — Perplexity с падением на Ollama при ошибке/таймауте
"""

import asyncio
import logging
import os
import time
from enum import Enum

logger = logging.getLogger(__name__)


class RoutingStrategy(str, Enum):
    AUTO = "auto"
    LOCAL = "local"
    CLOUD = "cloud"
    PARALLEL = "parallel"
    FALLBACK = "fallback"


class FallbackRouter:
    def __init__(self, perplexity_client, ollama_client):
        self.perplexity = perplexity_client
        self.ollama = ollama_client

        # Читать стратегию из env (можно менять без перезапуска через /api/config)
        self._strategy = RoutingStrategy(
            os.getenv("LLM_STRATEGY", RoutingStrategy.FALLBACK)
        )

        # Состояние провайдеров
        self._perplexity_ok: bool = bool(os.getenv("PERPLEXITY_API_KEY"))
        self._ollama_ok: bool | None = None  # проверяется при первом запросе

        # Счётчики для статистики
        self.stats = {"perplexity": 0, "ollama": 0, "errors": 0, "fallbacks": 0}

        logger.info(f"[FallbackRouter] Strategy: {self._strategy}")

    # ──────────────────────────────────────────────
    # Main entry point
    # ──────────────────────────────────────────────

    async def query(
        self,
        keyword: str,
        context: str = "",
        profile: str = "general",
    ) -> tuple[str | None, str]:
        """
        Выполнить запрос согласно стратегии.
        Возвращает (текст_ответа, провайдер: 'perplexity'|'ollama'|'none')
        """
        strategy = self._strategy

        # AUTO: выбрать по наличию ключей
        if strategy == RoutingStrategy.AUTO:
            if self._perplexity_ok:
                strategy = RoutingStrategy.CLOUD
            else:
                strategy = RoutingStrategy.LOCAL

        if strategy == RoutingStrategy.CLOUD:
            return await self._query_perplexity(keyword, context, profile)

        if strategy == RoutingStrategy.LOCAL:
            return await self._query_ollama(keyword, context, profile)

        if strategy == RoutingStrategy.FALLBACK:
            return await self._query_with_fallback(keyword, context, profile)

        if strategy == RoutingStrategy.PARALLEL:
            return await self._query_parallel(keyword, context, profile)

        return None, "none"

    def set_strategy(self, strategy: str):
        self._strategy = RoutingStrategy(strategy)
        logger.info(f"[FallbackRouter] Strategy changed to: {self._strategy}")

    def get_status(self) -> dict:
        return {
            "strategy": self._strategy,
            "perplexity_available": self._perplexity_ok,
            "ollama_available": self._ollama_ok,
            "stats": self.stats,
        }

    # ──────────────────────────────────────────────
    # Private strategies
    # ──────────────────────────────────────────────

    async def _query_perplexity(self, keyword, context, profile):
        result = await self.perplexity.query(keyword, context, profile)
        if result:
            self.stats["perplexity"] += 1
            return result, "perplexity"
        self.stats["errors"] += 1
        return None, "none"

    async def _query_ollama(self, keyword, context, profile):
        # Проверить доступность при первом вызове
        if self._ollama_ok is None:
            self._ollama_ok = await self.ollama.is_available()

        if not self._ollama_ok:
            logger.warning("[FallbackRouter] Ollama not available")
            return None, "none"

        result = await self.ollama.query(keyword, context, profile)
        if result:
            self.stats["ollama"] += 1
            return result, "ollama"
        self.stats["errors"] += 1
        return None, "none"

    async def _query_with_fallback(self, keyword, context, profile):
        """Попробовать Perplexity, при неудаче — Ollama."""
        if self._perplexity_ok:
            result = await self.perplexity.query(keyword, context, profile)
            if result:
                self.stats["perplexity"] += 1
                return result, "perplexity"
            logger.warning("[FallbackRouter] Perplexity failed → falling back to Ollama")
            self.stats["fallbacks"] += 1

        # Ollama fallback
        if self._ollama_ok is None:
            self._ollama_ok = await self.ollama.is_available()

        if self._ollama_ok:
            result = await self.ollama.query(keyword, context, profile)
            if result:
                self.stats["ollama"] += 1
                return result, "ollama"

        self.stats["errors"] += 1
        return None, "none"

    async def _query_parallel(self, keyword, context, profile):
        """Запустить оба провайдера параллельно, вернуть первый успешный."""
        tasks = []

        if self._perplexity_ok:
            tasks.append(("perplexity", self.perplexity.query(keyword, context, profile)))

        if self._ollama_ok is None:
            self._ollama_ok = await self.ollama.is_available()
        if self._ollama_ok:
            tasks.append(("ollama", self.ollama.query(keyword, context, profile)))

        if not tasks:
            return None, "none"

        # Запустить параллельно, вернуть первый непустой ответ
        pending = {
            asyncio.create_task(coro, name=name): name
            for name, coro in tasks
        }

        try:
            done, remaining = await asyncio.wait(
                pending.keys(),
                return_when=asyncio.FIRST_COMPLETED,
                timeout=8.0,
            )
            # Отменить оставшиеся
            for task in remaining:
                task.cancel()

            for task in done:
                try:
                    result = task.result()
                    if result:
                        provider = pending[task]
                        self.stats[provider] += 1
                        return result, provider
                except Exception:
                    pass
        except asyncio.TimeoutError:
            pass

        self.stats["errors"] += 1
        return None, "none"
