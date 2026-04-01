# ⚡ GCP Datanator - Production-Grade ETL Pipeline

GCP Datanator is a robust, enterprise-grade ETL (Extract, Transform, Load) pipeline designed to aggregate, parse, and structure data from various Google Cloud and AI RSS/Atom feeds. It transforms raw data into a clean, structured format optimized for ingestion into Knowledge Bases (like Google's NotebookLM or custom RAG applications).

It also features **Gemini Intelligence**, which automatically generates summaries and insights from the latest Google Cloud updates.

## 🚀 Quick Start

Get up and running with GCP Datanator in minutes:

1. **Clone and Install**
   ```bash
   git clone https://github.com/google-cloud/gcp-datanator.git
   cd gcp-datanator
   npm install
   ```

2. **Configure Environment**
   Create a `.env` file in the root directory:
   ```env
   GEMINI_API_KEY=your_gemini_api_key
   ```

3. **Start the Server**
   ```bash
   npm run dev
   ```

4. **Access the Dashboard**
   Open your browser and navigate to `http://localhost:3000`.

## ✨ Key Features

- **Automated Extraction:** Pulls data from 10+ official Google Cloud and AI blogs, release notes, and status feeds (configured in `src/server/etl/extractor.ts`).
- **Gemini Intelligence:** Leverages the Gemini API to automatically generate executive summaries and actionable insights from the latest aggregated data.
- **Intelligent Deduplication:** Tracks parsed GUIDs to ensure only net-new content is processed, saving bandwidth and storage.
- **Fail-Proof Architecture:** 
  - **Atomic Transactions:** File writes and database updates are strictly atomic. If a DB insert fails, orphaned files are automatically rolled back and deleted. Enhanced `fs` error logging captures exact file paths and stack traces for rapid debugging.
  - **Sequential Processing:** Prevents CPU/Memory OOM (Out-Of-Memory) spikes and SQLite database locks by processing feeds sequentially.
  - **Self-Healing & Concurrency:** Automatically detects and resets "stuck" sync jobs caused by unexpected server restarts. Uses `BEGIN IMMEDIATE TRANSACTION` during schema migrations to prevent deadlocks when multiple Cloud Run instances start concurrently.
  - **Graceful Shutdown:** Intercepts `SIGTERM` and `SIGINT` signals to safely close SQLite connections (`closeDb()`) before the container exits, preventing database corruption during scale-down events.
  - **Strict Network Timeouts:** Uses `Promise.race` to prevent hanging sockets from unresponsive external servers.
  - **Dynamic User-Agents & Exponential Backoff:** Bypasses basic rate-limiting and handles transient network failures gracefully.
- **Local Data Lake & GCS Persistence:** Saves processed data into a structured `data/` directory. When deployed to Cloud Run, this directory is mounted to a **Google Cloud Storage (GCS)** bucket using Cloud Storage FUSE, ensuring the SQLite database and text files survive container restarts.
- **Live React Dashboard & Cloud Logging:** A beautiful, dark-mode admin dashboard to monitor sync runs, source health, and recent logs in real-time. For production reliability, all logs are streamed directly to **Google Cloud Logging** via standard output, while a strict rolling window of the last 500 logs is maintained in SQLite for the dashboard.

## 🏗️ Architecture

The application is a Full-Stack TypeScript project:
- **Frontend:** React 19, Vite, Tailwind CSS, shadcn/ui.
- **Backend:** Express.js, SQLite (optimized for network-attached storage), `rss-parser`.

### Directory Structure

```text
/src
  /components     # React UI components (Dashboard, shadcn UI)
  /server
    /api          # Express API routes
    /db           # SQLite database initialization (DELETE mode for GCS FUSE, busy timeouts)
    /etl          # The core ETL pipeline
      extractor.ts  # Fetches, filters, and validates RSS/Atom feeds
      transformer.ts # Cleans HTML and formats the data
      loader.ts     # Saves to local disk (and optionally Google Cloud Storage)
      pipeline.ts   # Orchestrates the ETL process with atomic transactions
```

## ☁️ Production Deployment (Google Cloud Run)

GCP Datanator is designed to be deployed as a serverless container. Because it relies on background processing and a local SQLite database, **you must configure Cloud Run correctly to prevent data loss and frozen background jobs.**

We provide a highly optimized, multi-stage `Dockerfile.txt` and a `cloudbuild.yaml` file for automated CI/CD.

### Deployment Summary

Deploying to Cloud Run involves a few critical infrastructure components to ensure the app is secure, persistent, and automated:

1. **Service Accounts & Permissions:** 
   You will create a dedicated application service account (`gcp-datanator-app-sa`) that runs the container with minimal privileges, granting it access only to the necessary GCS buckets and Secret Manager secrets. A separate service account is used for the Cloud Scheduler.
2. **Secret Management:** 
   Sensitive credentials like `GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` are stored securely in **Google Secret Manager** and injected into the container at runtime as environment variables.
3. **GCS Bucket Mounting (Cloud Storage FUSE):** 
   Cloud Run containers are stateless. To persist the SQLite database (`gcp-datanator.db`) and downloaded feed files, a Google Cloud Storage (GCS) bucket is created and mounted directly to the container's `/app/data` directory using Cloud Storage FUSE. This requires the **Gen 2 execution environment** and restricting the service to a **single instance** (`--max-instances 1`) to prevent database locks.
4. **Automated Scheduling:** 
   The ETL pipeline is triggered automatically using **Google Cloud Scheduler**. A cron job securely invokes the `/api/v1/sync/monthly` endpoint via OIDC authentication, ensuring your data is always up-to-date without manual intervention.

### 📖 Full Deployment Guide
For the complete, step-by-step production deployment instructions, please read the **[Deployment Guide (deploy.md)](./deploy.md)**.

## 🔌 API & Automation

GCP Datanator exposes RESTful API endpoints to control the ETL pipeline programmatically, allowing for seamless integration with external systems and schedulers.

### Triggering a Sync via API
You can manually trigger a synchronization cycle via an HTTP GET or POST request. This is useful for CI/CD pipelines, custom webhooks, or manual overrides.

```bash
# Trigger via POST
curl -X POST http://localhost:3000/api/v1/sync/monthly \
  -H "Content-Type: application/json" \
  -d '{"triggerType": "MANUAL"}'

# Trigger via GET (automatically waits for completion to prevent Cloud Run CPU throttling)
curl http://localhost:3000/api/v1/sync/monthly?wait=true
```

### Automating with Cloud Scheduler
For production environments, you should automate the ETL pipeline using Google Cloud Scheduler to run at regular intervals (e.g., daily or weekly).

```bash
gcloud scheduler jobs create http gcp-datanator-sync \
  --schedule="0 2 * * 0,2,5" \
  --uri="https://YOUR_CLOUD_RUN_URL/api/v1/sync/monthly?wait=true" \
  --http-method=GET \
  --oidc-service-account-email=gcp-datanator-scheduler-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com
```
*Note: Using `GET` with `?wait=true` ensures Cloud Run keeps the CPU allocated until the background sync finishes.*

### 🗄️ GCS Integration & Persistence
Because Cloud Run containers are stateless, any data written to the local disk is lost when the container restarts. GCP Datanator solves this by using **Cloud Storage FUSE** to mount a Google Cloud Storage (GCS) bucket directly into the container's file system at `/app/data`.

This allows the SQLite database (`gcp-datanator.db`) and all extracted text files to persist across deployments and container restarts. The application is specifically optimized for network-attached storage using SQLite `DELETE` journal mode and extended busy timeouts.

To configure this during deployment:
1. Create a GCS bucket (e.g., `gs://my-datanator-storage`).
2. When deploying to Cloud Run, configure a volume mount:
   - **Volume Type:** Cloud Storage bucket
   - **Bucket Name:** `my-datanator-storage`
   - **Mount Path:** `/app/data`
3. Ensure the Cloud Run service account has the `Storage Object Admin` role on the bucket.

## 📊 Monitoring & Debugging

The built-in dashboard provides comprehensive monitoring:
- **Overview:** View total runs, items parsed over time, and system health.
- **Data Sources:** Monitor the health of individual feeds and trigger targeted syncs.
- **Gemini Intelligence:** Generate AI-powered summaries of recent Google Cloud updates.
- **Debug Console:** View recent application logs directly in the UI, including exact deduplication metrics (e.g., *Skipped 28 already parsed items for source: Google Cloud Blog*) and fatal errors.
- **Production Logging:** All logs are automatically captured by **Google Cloud Logging** for long-term retention, alerting, and analysis. The internal SQLite database enforces a strict 500-log hard cap to prevent database bloat and FUSE corruption.
- **Automated Cleanup:** The system automatically prunes old sync runs and orphaned files older than the configured retention period (default: 30 days) to prevent disk exhaustion.

## 🛡️ Error Handling

The pipeline is designed to be highly resilient:
- **Source Isolation:** If one data source fails to sync, it does not stop the entire pipeline. The run will be marked as `PARTIAL_SUCCESS`.
- **Database Rollbacks:** If saving a file succeeds but the subsequent database insert fails, the transaction is rolled back and the orphaned file is deleted from disk.
- **Global Catch-All:** The Express server includes global error handlers to prevent the process from crashing unexpectedly.
