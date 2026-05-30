FROM node:22-bookworm-slim AS builder

WORKDIR /app

ARG VITE_API_URL=http://localhost:5000
ENV VITE_API_URL=${VITE_API_URL}

# Two-step copy: copy package files and install deps to leverage cache
COPY package*.json ./
RUN npm install --no-audit --no-fund --legacy-peer-deps

# Now copy source and build
COPY . .
RUN npm run build

FROM nginx:1.27-alpine

RUN apk add --no-cache curl

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]