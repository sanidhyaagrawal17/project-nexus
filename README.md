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

## Configuration

Backend:

- `MONGO_URI`: MongoDB connection string used by the backend and ML pipeline.
- `PYTHON_EXECUTABLE`: Python executable used by the retraining scheduler.
- `PORT`: Backend HTTP port.
- `CORS_ORIGINS`: Comma-separated list of allowed frontend origins.

Frontend build:

- `VITE_API_URL`: API base URL embedded into the frontend build.

### Database Setup & Indexing

Before running the backend for the first time, initialize the database indexes by running: `node backend/scripts/init_db.js`.

If you are running the application outside Docker, set `MONGO_URI` and `PYTHON_EXECUTABLE` in your environment or `.env` file before starting the backend.

## Notes

- The frontend is now built into a static nginx image instead of running the Vite dev server.
- The backend only starts listening after MongoDB connects.
- Upload, resolve, and wipe routes are rate-limited.
- CORS is restricted to configured origins instead of allowing every origin.
