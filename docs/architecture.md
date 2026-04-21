# Архитектура системы

## Схема потока данных

```
┌─────────────────────────────────────────────────────────────────┐
│                      ПОЛЬЗОВАТЕЛЬ                               │
│                                                                 │
│  ┌─────────────┐    ┌─────────────────────────────────────┐    │
│  │ Zoom /       │    │           БРАУЗЕР (Frontend)         │    │
│  │ Яндекс      │    │                                     │    │
│  │ Телемост    │───▶│  ┌──────────────────────────────┐  │    │
│  └─────────────┘    │  │   Web Audio API Capture      │  │    │
│         │           │  │   (Virtual Cable / Tab)      │  │    │
│  Системный          │  └──────────────┬───────────────┘  │    │
│  звук через         │                 │ PCM16 chunks      │    │
│  Virtual Cable      │  ┌──────────────▼───────────────┐  │    │
│                     │  │   DeepgramClient (WS proxy)   │  │    │
│                     │  └──────────────┬───────────────┘  │    │
│                     │                 │ WebSocket         │    │
│                     │  ┌──────────────▼───────────────┐  │    │
│                     │  │       HintsClient             │  │    │
│                     │  │  (debounce 2s, dedup)        │  │    │
│                     │  └──────────────┬───────────────┘  │    │
│                     │                 │ POST /api/hints   │    │
│                     │  ┌──────────────▼───────────────┐  │    │
│                     │  │        Overlay UI             │  │    │
│                     │  │  critical🔴 high🟠 med🟡 low🟢│  │    │
│                     │  └──────────────────────────────┘  │    │
│                     └─────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              │ WebSocket /ws/transcribe
                              │ HTTP POST /api/hints
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   BACKEND (Python FastAPI)                      │
│                                                                 │
│  ┌────────────────────┐    ┌─────────────────────────────┐     │
│  │  /ws/transcribe    │    │      /api/hints              │     │
│  │                    │    │                              │     │
│  │  WS Proxy:         │    │  KeywordExtractor            │     │
│  │  Browser ──▶ DG    │    │  (spaCy NER +               │     │
│  │  DG results ──▶    │    │   профильные триггеры)      │     │
│  │  Browser           │    │          │                   │     │
│  └────────────────────┘    │          ▼                   │     │
│                            │  PerplexityClient            │     │
│                            │  (async, semaphore=3)        │     │
│                            │          │                   │     │
│                            │          ▼                   │     │
│                            │  PriorityEngine              │     │
│                            │  (critical/high/med/low)     │     │
│                            └─────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
                    │                        │
                    ▼                        ▼
        ┌───────────────────┐    ┌───────────────────────┐
        │   DEEPGRAM API    │    │   PERPLEXITY API      │
        │                   │    │                       │
        │  Nova-2-Medical   │    │  sonar-small-128k     │
        │  Diarization: on  │    │  online (with search) │
        │  Language: ru     │    │  max_tokens: 300      │
        │  Punctuate: on    │    │  temperature: 0.2     │
        └───────────────────┘    └───────────────────────┘
```

## Компоненты

| Компонент | Технология | Назначение |
|-----------|-----------|------------|
| Audio Capture | Web Audio API + ScriptProcessor | Захват PCM16 аудио |
| Deepgram Proxy | WebSocket (Python ↔ Deepgram) | Скрыть API-ключ, диаризация |
| Keyword Extractor | spaCy NER + словари | Выделить медтермины/вопросы |
| Perplexity Client | httpx async + semaphore | Поиск фактов в реальном времени |
| Priority Engine | Regex patterns | Классификация критичности |
| Overlay UI | Vanilla JS + CSS | Неинвазивный оверлей |

## Задержки (latency)

| Этап | Типичная задержка |
|------|-----------------|
| Audio → Deepgram | ~200–400 мс |
| Deepgram → Transcript | ~100–300 мс |
| Keyword extraction | <10 мс |
| Perplexity query | 1–3 сек |
| UI render | <5 мс |
| **Итого до подсказки** | **~3–5 сек** |

## Масштабирование

- **Локально**: 1 пользователь, всё на localhost
- **Облако (Fly.io)**: до 25 параллельных WS-соединений на shared VM
- **Production**: Отдельные инстансы backend + Redis для дедупликации между пользователями
