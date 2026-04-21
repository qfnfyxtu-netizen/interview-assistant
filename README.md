# 🎙️ Real-Time Interview Assistant

Интеллектуальный оверлей-ассистент реального времени для медицинских консультаций и собеседований.  
Захватывает аудио из Zoom/Яндекс Телемост → транскрибирует через Deepgram → извлекает ключевые слова → запрашивает Perplexity API → выводит приоритизированные подсказки в оверлее.

```
Audio (Zoom/Telemost)
        │
        ▼
[Web Audio API Capture]  ──loopback──  [Virtual Cable / BlackHole]
        │
        ▼
[Deepgram WebSocket]  ──streaming──  [Diarized Transcript]
        │
        ▼
[Python FastAPI Backend]
   ├── KeywordExtractor (spaCy / keyBERT)
   ├── PerplexityClient (async)
   └── PriorityEngine (scorer)
        │
        ▼
[Overlay UI]  ──floating window──  [Prioritized Hints]
```

---

## ⚡ Быстрый старт (локально, 5 минут)

### Требования
- Node.js ≥ 18
- Python ≥ 3.11
- [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) (Windows) или [BlackHole](https://existential.audio/blackhole/) (macOS)
- API-ключи: [Deepgram](https://console.deepgram.com/), [Perplexity](https://www.perplexity.ai/settings/api)

### 1. Клонировать и установить зависимости

```bash
git clone https://github.com/YOUR_USERNAME/interview-assistant.git
cd interview-assistant

# Backend
cd backend
python -m venv venv && source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
python -m spacy download ru_core_news_sm
python -m spacy download en_core_web_sm

# Frontend
cd ../frontend
npm install
```

### 2. Настроить переменные окружения

```bash
# backend/.env
cp backend/.env.example backend/.env
# Заполнить DEEPGRAM_API_KEY и PERPLEXITY_API_KEY
```

### 3. Запустить

```bash
# Терминал 1: Backend
cd backend && source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Терминал 2: Frontend
cd frontend && npm run dev
# Открыть http://localhost:3000
```

### Или через Docker Compose (рекомендуется)

```bash
cp .env.example .env  # заполнить ключи
docker-compose up -d
# Открыть http://localhost:3000
```

---

## 🔧 Настройка захвата аудио

### Windows — VB-Audio Virtual Cable
1. Установить [VB-Audio Cable](https://vb-audio.com/Cable/)
2. В Zoom: `Настройки → Аудио → Динамик → CABLE Input`
3. В браузере при запросе разрешения выбрать `CABLE Output` как микрофон

### macOS — BlackHole
1. Установить BlackHole: `brew install blackhole-2ch`
2. В `Аудио MIDI Setup` создать Multi-Output Device (динамики + BlackHole)
3. В Zoom выбрать этот Multi-Output как вывод звука
4. В браузере выбрать BlackHole как источник

### Linux — PulseAudio loopback
```bash
pactl load-module module-loopback
# Выбрать Monitor of [output device] в браузере
```

---

## 🏥 Режим: Медицинская консультация

Профиль `medical` настроен для:
- Распознавания диагнозов, препаратов, дозировок
- Критериев классификации (ACR/EULAR, DSM-5)
- Ссылок на клинические рекомендации (МКБ-10, КР РФ)
- Противопоказаний и лекарственных взаимодействий

Пример промпта (см. `examples/medical/prompts.json`):
```json
{
  "context": "rheumatology_outpatient",
  "triggers": ["метотрексат", "ритуксимаб", "критерии ACR", "DAS28"],
  "response_format": "brief_clinical"
}
```

## 💼 Режим: Собеседование

Профиль `interview` настроен для:
- Поведенческих вопросов (STAR-метод)
- Технических терминов и определений
- Контраргументов и уточняющих вопросов
- Подсказок о паузах и структуре ответа

---

## ☁️ Деплой в облако

### Fly.io (рекомендуется — бесплатный tier)
```bash
cd deploy/cloud
fly auth login
fly launch --config fly.toml
fly secrets set DEEPGRAM_API_KEY=xxx PERPLEXITY_API_KEY=xxx
fly deploy
```

### Railway
```bash
# Импортировать репозиторий на railway.app
# Добавить переменные окружения в панели
# Deploy автоматически
```

---

## 📡 API Endpoints (Backend)

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/ws/transcribe` | WebSocket: Deepgram proxy с диаризацией |
| `POST` | `/api/hints` | Получить подсказки по тексту |
| `GET` | `/api/profiles` | Список профилей (medical, interview) |
| `POST` | `/api/profiles/{name}` | Сохранить кастомный профиль |
| `GET` | `/health` | Health check |

---

## 🗂️ Структура проекта

```
interview-assistant/
├── frontend/
│   ├── src/
│   │   ├── audio/          # Web Audio API захват
│   │   ├── deepgram/       # WebSocket клиент
│   │   ├── overlay/        # UI оверлей
│   │   └── utils/          # Вспомогательные модули
│   ├── public/
│   └── package.json
├── backend/
│   ├── main.py             # FastAPI приложение
│   ├── routers/
│   │   ├── transcribe.py   # WebSocket proxy
│   │   └── hints.py        # Hints API
│   ├── services/
│   │   ├── keyword_extractor.py
│   │   ├── perplexity_client.py
│   │   └── priority_engine.py
│   ├── models/
│   │   └── schemas.py
│   └── requirements.txt
├── examples/
│   ├── medical/
│   └── job-interview/
├── deploy/
│   ├── local/docker-compose.yml
│   └── cloud/fly.toml
└── .env.example
```

---

## 🔑 Получение API-ключей

**Deepgram** (транскрипция):
1. Зарегистрироваться на [console.deepgram.com](https://console.deepgram.com/)
2. `Create API Key` → скопировать ключ
3. Бесплатно: $200 кредитов при регистрации (~1600 часов аудио)

**Perplexity** (поиск фактов):
1. Зарегистрироваться на [perplexity.ai](https://www.perplexity.ai/)
2. `Settings → API → Generate` → скопировать ключ
3. Модель: `llama-3.1-sonar-small-128k-online` (быстрая и дешёвая)

---

## 📝 Лицензия

MIT License — используйте свободно для личных и коммерческих целей.
