# syntax=docker/dockerfile:1.7

FROM python:3.10-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN test -f config.json || cp config.example.json config.json \
    && groupadd --gid 10001 mimo2api \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /app --shell /usr/sbin/nologin mimo2api \
    && chown -R 10001:10001 /app

USER 10001:10001

EXPOSE 8080

CMD ["python", "main.py"]
