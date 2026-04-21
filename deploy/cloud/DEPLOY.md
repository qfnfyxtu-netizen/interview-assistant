# Деплой в облако

## Fly.io (рекомендуется — бесплатный tier)

### Установка fly CLI
```bash
# macOS
brew install flyctl

# Linux
curl -L https://fly.io/install.sh | sh

# Windows
powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

### Деплой backend
```bash
cd backend
fly auth login
fly launch --name interview-assistant-api --region ams
fly secrets set DEEPGRAM_API_KEY=xxxx PERPLEXITY_API_KEY=xxxx
fly deploy
```

После деплоя получите URL вида: `https://interview-assistant-api.fly.dev`

### Настроить frontend для облака
В `frontend/.env.production`:
```
VITE_BACKEND_URL=https://interview-assistant-api.fly.dev
```

---

## Railway (альтернатива)

1. Зарегистрироваться на [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
3. Выбрать папку `backend`
4. Добавить переменные: `DEEPGRAM_API_KEY`, `PERPLEXITY_API_KEY`
5. Railway автоматически определит Python и задеплоит

---

## Render (бесплатно, но cold start ~30 сек)

1. [render.com](https://render.com) → New Web Service
2. Подключить GitHub репозиторий
3. Root Directory: `backend`
4. Build Command: `pip install -r requirements.txt && python -m spacy download ru_core_news_sm`
5. Start Command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
6. Добавить env vars

---

## WebSocket в облаке

Для WebSocket в облаке убедитесь что:
- Используется `wss://` (не `ws://`)
- Таймаут proxy ≥ 3600 секунд
- Fly.io и Railway поддерживают WebSocket нативно
