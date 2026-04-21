FROM python:3.11-slim

WORKDIR /app

# Системные зависимости для spaCy
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Скачать spaCy модели
RUN python -m spacy download ru_core_news_sm && \
    python -m spacy download en_core_web_sm

COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
