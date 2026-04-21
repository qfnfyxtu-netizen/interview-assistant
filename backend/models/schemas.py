"""
Pydantic-схемы для API.
"""

from pydantic import BaseModel, Field
from typing import Literal, Optional


class HintsRequest(BaseModel):
    text: str = Field(..., description="Транскрибированный текст для анализа")
    profile: str = Field(default="general", description="Профиль: medical | interview | general")


class HintItem(BaseModel):
    text: str = Field(..., description="Текст подсказки")
    priority: Literal["critical", "high", "medium", "low"] = Field(default="medium")
    source: Optional[str] = Field(default=None, description="Источник (ссылка или название)")
    query: Optional[str] = Field(default=None, description="Ключевое слово/запрос")


class HintsResponse(BaseModel):
    keywords: list[str] = Field(default_factory=list)
    hints: list[HintItem] = Field(default_factory=list)
