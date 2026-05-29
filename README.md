# Project Nexus

Project Nexus is a production-oriented fraud detection and risk analytics platform. It ingests transaction telemetry, scores it with a Python ML pipeline, stores alerts and file metadata in MongoDB, and presents analysts with a React dashboard for review, resolution, and operational visibility.

## What It Does

Project Nexus is designed to help investigators and analysts detect suspicious financial activity from CSV-based telemetry. The backend accepts uploads, deduplicates files by hash, forwards new datasets to the ML pipeline, stores the resulting alerts in MongoDB, and streams processing status to the dashboard. The frontend then presents the resulting alerts, metrics, threshold analysis, and SHAP-style feature explanations in a single analyst workspace.

## Core Technologies

The project is built with:

- `backend`: Node.js and Express API with Socket.IO progress updates, rate limiting, file ingestion, and MongoDB integration
- `frontend`: React dashboard served as a static build through nginx
- `ml-pipeline`: Python inference, anomaly scoring, SHAP explainability, and scheduled retraining support
- `mongodb`: persistent document store for alerts, processed files, activity logs, and analyst feedback
- `docker-compose`: local and deployment orchestration for the full stack

## Architecture Summary

1. A CSV upload arrives at the backend and is hashed to prevent duplicate processing.
2. New files are written to the ML pipeline data directory and scored by the Python inference service.
3. Alerts, processed file metadata, and analyst feedback are persisted in MongoDB.
4. Socket.IO pushes progress and completion events to the React dashboard.
5. The retraining scheduler can launch the Python retraining job on a weekly cadence.
6. Live transaction events can be buffered for a short window and scored as micro-batches.

## Repository Layout

- `backend`: API server, scheduler, initialization scripts, and MongoDB models
- `frontend`: React UI and dashboard views
- `ml-pipeline`: training, inference, demo data generation, and SHAP export logic
- `docker-compose.yml`: full-stack local/deployment orchestration

## Run locally

```bash
docker compose up -d --build
```

Then open:

- Frontend: http://localhost:5173
- Frontend alias: http://nexus
- Backend: http://localhost:5000/healthz
- Backend readiness: http://localhost:5000/readyz

To use `http://nexus` on Windows, run `scripts/register-nexus-host.ps1` from an elevated PowerShell session once. That adds `127.0.0.1 nexus` to your hosts file so the browser can resolve the name locally.

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

### Live Stream Ingest

Send transaction events to `POST /api/live-events` as a single object, an `event` wrapper, or an `events` array. Each event should include `source_account` and `destination_account`, plus optional `amount`, `timestamp`, `transaction_type`, and `channel` fields.

Example:

```bash
curl -X POST http://localhost:5000/api/live-events \
	-H "Content-Type: application/json" \
	-d '{"events":[{"source_account":"A123","destination_account":"B456","amount":1800.5,"timestamp":"2026-05-27T12:00:00Z","transaction_type":"WIRE_TRANSFER","channel":"api"}]}'
```

The backend buffers events for a short window, sends them to the Python scorer, stores any resulting alerts, and emits Socket.IO updates when the batch completes.

## Notes

- The frontend is now built into a static nginx image instead of running the Vite dev server.
- The backend only starts listening after MongoDB connects.
- Upload, resolve, and wipe routes are rate-limited.
- CORS is restricted to configured origins instead of allowing every origin.
