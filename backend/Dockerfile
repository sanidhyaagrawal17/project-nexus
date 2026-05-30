FROM node:22-bookworm-slim

WORKDIR /app

# Install minimal OS packages if needed
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Two-step copy: copy backend package files first to leverage Docker cache for dependencies
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --no-audit --no-fund --omit=dev

# Copy remaining source
COPY backend ./backend

WORKDIR /app/backend
EXPOSE 5000

CMD ["npm", "start"]