FROM node:22-bookworm-slim

ENV PYTHONUNBUFFERED=1
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/package*.json ./backend/
RUN cd backend && npm install

COPY backend ./backend
COPY ml-pipeline/requirements.txt ./ml-pipeline/requirements.txt
RUN python3 -m venv "$VIRTUAL_ENV" \
    && pip install --no-cache-dir -r ml-pipeline/requirements.txt
COPY ml-pipeline ./ml-pipeline

WORKDIR /app/backend
EXPOSE 5000

CMD ["npm", "start"]