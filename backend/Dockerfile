# Use the Node image that supports Debian (Bookworm)
FROM node:22-bookworm

# Install Python and Pip
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

# FIX 1: Explicitly copy from the backend/ directory
COPY backend/package*.json ./
RUN npm install

# This is already correct because it specifies ml-pipeline/ relative to root
COPY ml-pipeline/requirements.txt ./
RUN pip3 install --break-system-packages -r requirements.txt

# FIX 2: Copy the backend source code specifically
COPY backend/ ./

EXPOSE 5000

CMD ["node", "server.js"]