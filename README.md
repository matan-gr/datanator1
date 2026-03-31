# ⚡ GCP Datanator - Production-Grade ETL Pipeline

GCP Datanator is a robust, enterprise-grade ETL (Extract, Transform, Load) pipeline designed to aggregate, parse, and structure data from various Google Cloud and AI RSS/Atom feeds. It transforms raw data into a clean, structured format optimized for ingestion into Knowledge Bases (like Google's NotebookLM or custom RAG applications).

## ✨ Key Features

- **Automated Extraction:** Pulls data from 10+ official Google Cloud and AI blogs, release notes, and status feeds.
- **Intelligent Deduplication:** Tracks parsed GUIDs to ensure only net-new content is processed, saving bandwidth and storage.
- **Fail-Proof Architecture:** 
  - **Atomic Transactions:** File writes and database updates are strictly atomic. If a DB insert fails, orphaned files are automatically rolled back and deleted.
  - **Sequential Processing:** Prevents CPU/Memory OOM (Out-Of-Memory) spikes and SQLite database locks by processing feeds sequentially.
  - **Self-Healing:** Automatically detects and resets "stuck" sync jobs caused by unexpected server restarts.
  - **Strict Network Timeouts:** Uses `Promise.race` to prevent hanging sockets from unresponsive external servers.
  - **Dynamic User-Agents & Exponential Backoff:** Bypasses basic rate-limiting and handles transient network failures gracefully.
- **Local Data Lake:** Saves processed data locally into a structured `data/` directory, simulating a production data lake.
- **Live React Dashboard:** A beautiful, dark-mode admin dashboard to monitor sync runs, source health, debug logs, and network activity in real-time.

## 🏗️ Architecture

The application is a Full-Stack TypeScript project:
- **Frontend:** React 19, Vite, Tailwind CSS, shadcn/ui, Recharts.
- **Backend:** Express.js, SQLite (with WAL mode enabled for high concurrency), `rss-parser`.

### Directory Structure

```text
/src
  /components     # React UI components (Dashboard, shadcn UI)
  /server
    /api          # Express API routes
    /db           # SQLite database initialization (WAL mode, busy timeouts)
    /etl          # The core ETL pipeline
      extractor.ts  # Fetches, filters, and validates RSS/Atom feeds
      transformer.ts # Cleans HTML and formats the data
      loader.ts     # Saves to local disk (and optionally Google Drive)
      pipeline.ts   # Orchestrates the ETL process with atomic transactions
```

## 🚀 Getting Started (Local Development)

### Prerequisites
- Node.js (v18+)
- npm

### Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open your browser and navigate to `http://localhost:3000`.
   - **Admin Password:** `admin123` (Configurable in `.env`)

## ☁️ Production Deployment (Google Cloud Run)

GCP Datanator is designed to be deployed as a serverless container. Because it relies on background processing and a local SQLite database, **you must configure Cloud Run correctly to prevent data loss and frozen background jobs.**

We provide a highly optimized, multi-stage `Dockerfile.txt` that compiles the TypeScript backend with `esbuild` and the React frontend with `vite`, resulting in a lightweight, secure production image.

### 📖 Full Deployment Guide
For the complete, step-by-step production deployment instructions (including setting up Artifact Registry, Cloud Storage FUSE for SQLite persistence, Secret Manager, and Cloud Scheduler), please read the **[Deployment Guide (deploy.md)](./deploy.md)**.

### Quick Build Overview
```bash
# 1. Build the production image using the provided Dockerfile.txt
docker build -t gcp-datanator:latest -f Dockerfile.txt .

# 2. Push to Google Artifact Registry
docker tag gcp-datanator:latest us-central1-docker.pkg.dev/YOUR_PROJECT/repo/gcp-datanator:latest
docker push us-central1-docker.pkg.dev/YOUR_PROJECT/repo/gcp-datanator:latest
```

## 📊 Monitoring & Debugging

The built-in dashboard provides comprehensive monitoring:
- **Overview:** View total runs, items parsed over time, and system health.
- **Data Sources:** Monitor the health of individual feeds and trigger targeted syncs.
- **Debug Console:** View live application logs, including exact deduplication metrics (e.g., *Fetched 30 items. Skipped 28 duplicates.*) and fatal errors.
- **Automated Cleanup:** The system automatically prunes logs and orphaned files older than the configured retention period (default: 30 days) to prevent disk exhaustion.

## 🛡️ Error Handling

The pipeline is designed to be highly resilient:
- **Source Isolation:** If one data source fails to sync, it does not stop the entire pipeline. The run will be marked as `PARTIAL_SUCCESS`.
- **Database Rollbacks:** If saving a file succeeds but the subsequent database insert fails, the transaction is rolled back and the orphaned file is deleted from disk.
- **Global Catch-All:** The Express server includes global error handlers to prevent the process from crashing unexpectedly.
