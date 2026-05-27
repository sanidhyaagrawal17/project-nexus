# Project Nexus

Project Nexus is a Dockerized fraud-detection dashboard with a Node.js API, a React frontend, MongoDB storage, and a Python ML inference pipeline.

## Production stack

- `backend`: Express API, Socket.IO progress updates, MongoDB persistence, Python ML worker orchestration
- `frontend`: static React build served by nginx
- `mongodb`: persistent document store
- `ml-pipeline`: Python inference and SHAP explainability scripts

## Run locally

```bash
docker compose up -d --build
```

Then open:

- Frontend: http://localhost:5173
- Backend: http://localhost:5000/healthz
- Backend readiness: http://localhost:5000/readyz

## Environment variables

Backend:

- `MONGO_URI`
- `PORT`
- `ML_PYTHON_EXECUTABLE`
- `CORS_ORIGINS`
- `MAX_JSON_BODY_SIZE`
- `MAX_URLENCODED_BODY_SIZE`
- `MAX_UPLOAD_SIZE_MB`

Frontend build:

- `VITE_API_URL`

## Notes

- The frontend is now built into a static nginx image instead of running the Vite dev server.
- The backend only starts listening after MongoDB connects.
- Upload, resolve, and wipe routes are rate-limited.
- CORS is restricted to configured origins instead of allowing every origin.
