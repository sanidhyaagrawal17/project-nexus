FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Two-step copy: copy only requirements first to leverage Docker layer caching
COPY requirements.txt ./
RUN python -m venv "$VIRTUAL_ENV" \
    && pip install --no-cache-dir -r requirements.txt

# Then copy the rest of the source
COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]