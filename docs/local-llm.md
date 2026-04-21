# Локальный LLM (Ollama + Qwen) — Руководство по настройке

## Зачем локальный режим?

- **Offline** — работает без интернета и без VPN
- **Конфиденциальность** — данные пациентов не покидают устройство
- **Скорость** — на RTX 5050 8GB ответ ~2–4 сек vs 1–3 сек у Perplexity
- **Бесплатно** — нет расхода API-кредитов

## Установка Ollama

### Windows / macOS
Скачать установщик: https://ollama.com/download

### Linux
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

## Выбор модели под RTX 5050 (8GB VRAM)

| Модель | VRAM | Скорость | Качество | Команда |
|--------|------|----------|----------|---------|
| `qwen2.5:7b-instruct-q4_K_M` | ~4.5 GB | ~25 tok/s | ★★★★☆ | `ollama pull qwen2.5:7b-instruct-q4_K_M` |
| `qwen2.5:14b-instruct-q4_K_M` | ~8.0 GB | ~12 tok/s | ★★★★★ | `ollama pull qwen2.5:14b-instruct-q4_K_M` |
| `qwen3:8b-q4_K_M` | ~5.0 GB | ~20 tok/s | ★★★★☆ | `ollama pull qwen3:8b-q4_K_M` |
| `medllama3:8b` | ~5.5 GB | ~18 tok/s | ★★★☆☆ | `ollama pull medllama3:8b` |

> **Рекомендация**: `qwen2.5:7b-instruct-q4_K_M` — оптимальный баланс  
> При 64 GB RAM можно запустить 14B модель с offload части слоёв в RAM

## Настройка

```bash
# 1. Скачать модель
ollama pull qwen2.5:7b-instruct-q4_K_M

# 2. Проверить
ollama run qwen2.5:7b-instruct-q4_K_M "Доза метотрексата при РА?"

# 3. Убедиться что сервер слушает на 11434
curl http://localhost:11434/api/tags
```

В `.env`:
```
LLM_STRATEGY=fallback
OLLAMA_MODEL=qwen2.5:7b-instruct-q4_K_M
OLLAMA_BASE_URL=http://localhost:11434
```

## Стратегии маршрутизации

```
LLM_STRATEGY=auto      → Perplexity если есть ключ, иначе Ollama
LLM_STRATEGY=fallback  → Perplexity → при ошибке Ollama  ← рекомендуется
LLM_STRATEGY=local     → только Ollama (полный offline)
LLM_STRATEGY=cloud     → только Perplexity
LLM_STRATEGY=parallel  → оба сразу, побеждает быстрейший
```

### Переключение в рантайме (без перезапуска)
```bash
# Переключиться в локальный режим
curl -X POST http://localhost:8000/api/config/strategy \
  -H "Content-Type: application/json" \
  -d '{"strategy": "local"}'

# Проверить статус
curl http://localhost:8000/api/config/status
```

## Производительность на Gigabyte Aero X16 (RTX 5050 8GB)

Тест qwen2.5:7b-instruct-q4_K_M, запрос «метотрексат при РА»:

| Метрика | Значение |
|---------|----------|
| Time to first token | ~0.8 сек |
| Скорость генерации | ~25 токенов/сек |
| Полный ответ (250 токенов) | ~3.5 сек |
| Потребление VRAM | ~4.5 GB |
| RAM | ~1 GB |

## Оффлайн-режим (полный)

При `LLM_STRATEGY=local` система работает без интернета:
- ✅ Deepgram — нужен интернет (или замените на Whisper local)  
- ✅ Perplexity — не используется
- ✅ Ollama/Qwen — полностью локально

### Whisper как локальная замена Deepgram
```bash
pip install openai-whisper
# В backend/services/ есть заготовка whisper_client.py (coming soon)
```

## Индикатор провайдера в UI

Подсказки в оверлее показывают источник:
- `🌐 КР РФ / ACR [perplexity]` — ответ от Perplexity
- `🖥 КР РФ / ACR [ollama]` — ответ от локального Qwen
