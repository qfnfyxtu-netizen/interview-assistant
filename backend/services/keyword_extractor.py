"""
Keyword Extractor Service
Извлекает ключевые медицинские/профессиональные термины из транскрипции.
Стратегия: spaCy NER + профильные словари + частотный анализ.
"""

import re
import logging
from collections import Counter

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────
# Профильные словари триггеров (загружаются один раз)
# ─────────────────────────────────────────────────────────────

MEDICAL_TRIGGERS = {
    # Препараты
    "метотрексат", "ритуксимаб", "тоцилизумаб", "абатацепт", "адалимумаб",
    "инфликсимаб", "барицитиниб", "упадацитиниб", "белимумаб", "микофенолат",
    "гидроксихлорохин", "сульфасалазин", "лефлуномид", "азатиоприн",
    "циклофосфамид", "преднизолон", "метилпреднизолон", "дексаметазон",
    "аллопуринол", "febuxostat", "колхицин", "диклофенак", "мелоксикам",
    # Диагнозы
    "ревматоидный артрит", "системная красная волчанка", "склеродермия",
    "васкулит", "подагра", "анкилозирующий спондилит", "псориатический артрит",
    "болезнь бехтерева", "фибромиалгия", "остеоартроз", "остеопороз",
    "гигантоклеточный артериит", "синдром шегрена",
    # Критерии и шкалы
    "das28", "cdai", "sdai", "acr", "eular", "sledai", "vas",
    "критерии acr", "критерии eular", "критерии диагностики",
    # Лабораторные показатели
    "анти-ццп", "ревматоидный фактор", "ана", "анти-dna", "анти-sm",
    "срб", "соэ", "крп", "ферритин", "прокальцитонин",
    # Процедуры
    "биопсия", "артроскопия", "денситометрия", "синовиальная жидкость",
}

INTERVIEW_TRIGGERS = {
    # HR-вопросы
    "расскажите о себе", "ваши сильные стороны", "слабые стороны",
    "почему вы", "карьерные цели", "конфликт", "достижения",
    "зарплатные ожидания", "почему уходите",
    # Поведенческие
    "star метод", "ситуация задача действие результат",
    "пример из практики", "трудная ситуация", "работа в команде",
    # Профессиональные
    "клинические рекомендации", "стандарты лечения", "протокол",
    "дифференциальный диагноз", "лечебная тактика",
}

GENERAL_TRIGGERS = set()


class KeywordExtractor:
    def __init__(self):
        # Попытаться загрузить spaCy для NER
        self._nlp = None
        self._load_spacy()

    def _load_spacy(self):
        try:
            import spacy
            try:
                self._nlp = spacy.load("ru_core_news_sm")
                logger.info("[KeywordExtractor] spaCy ru_core_news_sm loaded")
            except OSError:
                try:
                    self._nlp = spacy.load("en_core_web_sm")
                    logger.info("[KeywordExtractor] spaCy en_core_web_sm loaded")
                except OSError:
                    logger.warning("[KeywordExtractor] spaCy model not found, using fallback")
        except ImportError:
            logger.warning("[KeywordExtractor] spaCy not installed, using regex fallback")

    def extract(self, text: str, profile: str = "general", max_keywords: int = 5) -> list[str]:
        """
        Извлечь ключевые термины из текста.
        Возвращает список строк, отсортированных по релевантности.
        """
        text_lower = text.lower()
        found = []

        # 1. Совпадения с профильными триггерами
        triggers = self._get_triggers(profile)
        for trigger in triggers:
            if trigger in text_lower:
                found.append((trigger, 3.0))  # высокий вес

        # 2. spaCy NER (имена существительные, организации, термины)
        if self._nlp:
            doc = self._nlp(text)
            for ent in doc.ents:
                if ent.label_ in ("ORG", "PRODUCT", "GPE", "MISC", "PER"):
                    found.append((ent.text.lower(), 2.0))
            # Существительные как дополнительные кандидаты
            for token in doc:
                if token.pos_ in ("NOUN", "PROPN") and len(token.text) > 4:
                    found.append((token.text.lower(), 1.0))

        # 3. Fallback: извлечь длинные слова (если нет spaCy)
        if not self._nlp:
            words = re.findall(r'\b[а-яёА-ЯЁa-zA-Z]{5,}\b', text)
            for w in words:
                found.append((w.lower(), 0.5))

        # Агрегировать и сортировать
        counter = Counter()
        for term, weight in found:
            counter[term] += weight

        # Убрать стоп-слова
        stop_words = {"когда", "который", "этого", "также", "можно", "после",
                      "перед", "более", "менее", "такой", "такая", "такие"}
        results = [
            term for term, _ in counter.most_common(max_keywords * 2)
            if term not in stop_words and len(term) > 3
        ]

        return results[:max_keywords]

    def _get_triggers(self, profile: str) -> set:
        if profile == "medical":
            return MEDICAL_TRIGGERS
        elif profile == "interview":
            return INTERVIEW_TRIGGERS | MEDICAL_TRIGGERS  # врачи на собесе говорят про медицину
        return GENERAL_TRIGGERS
