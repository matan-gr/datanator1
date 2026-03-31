# 🚀 Ultimate Guide: Deploying GCP Datanator to Cloud Run

This guide provides comprehensive, step-by-step instructions for deploying the **GCP Datanator** ETL pipeline and Admin Dashboard to Google Cloud Run using **Cloud Build** for a simplified, automated CI/CD pipeline.

## 🌟 Architecture & Production Readiness

This application is engineered for enterprise-grade production environments:
*   **Lightweight Container:** Uses a multi-stage `node:22-alpine` Docker build. The final image contains *only* production dependencies and compiled assets (no raw TypeScript files or dev tools).
*   **Security:** `npm ci --omit=dev` ensures no development dependencies are included in the runtime. The container runs with minimal privileges.
*   **Persistence:** Uses Google Cloud Storage (GCS) FUSE to mount a persistent volume, ensuring the SQLite database and downloaded feeds survive ephemeral container restarts.
*   **Concurrency & Stability:** SQLite is configured with WAL (Write-Ahead Logging) mode and busy timeouts. Cloud Run is configured with `--max-instances 1` and `--no-cpu-throttling` to prevent database locks and ensure background ETL jobs complete successfully without being frozen by GCP.

---

## 🛠️ Prerequisites

1.  **Google Cloud Project**: A GCP project with billing enabled.
2.  **gcloud CLI**: Installed and authenticated (`gcloud auth login`).
3.  **Docker**: Installed and running on your local machine.
4.  **Set your active project**:
    ```bash
    gcloud config set project YOUR_PROJECT_ID
    ```
    *(This ensures all subsequent commands and Cloud Build automatically use the correct project).*
5.  **Required APIs Enabled**:
    ```bash
    gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com storage.googleapis.com artifactregistry.googleapis.com
    ```

---

## 📦 Step 1: Create Artifact Registry & GCS Bucket

1.  **Create an Artifact Registry Repository:**
    ```bash
    gcloud artifacts repositories create datanator-repo \
      --repository-format=docker \
      --location=us-central1 \
      --description="Docker repository for GCP Datanator"
    ```

2.  **Create a GCS Bucket for SQLite Data**:
    Cloud Run containers are stateless. To persist the SQLite database and output files, you must mount a Google Cloud Storage (GCS) bucket.
    ```bash
    gcloud storage buckets create gs://YOUR_PROJECT_ID-gcp-datanator-data --location=us-central1
    ```
    *(Note: The bucket name must be globally unique).*

---

## 🔐 Step 2: Service Accounts and Permissions

You need two service accounts: one for the application itself and one for the automated scheduler. You also need to grant Cloud Build permissions to deploy.

### 1. Application Service Account
This account runs the Cloud Run service and needs access to the storage bucket.

```bash
# Create the service account
gcloud iam service-accounts create gcp-datanator-app-sa \
    --display-name="GCP Datanator Application Service Account"

# Grant storage access for the SQLite volume
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
    --member="serviceAccount:gcp-datanator-app-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/storage.objectAdmin"
```

### 2. Scheduler Service Account
This account triggers the monthly sync securely.

```bash
gcloud iam service-accounts create gcp-datanator-scheduler-sa \
    --display-name="GCP Datanator Scheduler Service Account"

# Grant permission to invoke the Cloud Run service
gcloud run services add-iam-policy-binding gcp-datanator \
    --region=us-central1 \
    --member="serviceAccount:gcp-datanator-scheduler-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/run.invoker"
```

### 3. Cloud Build Permissions
To allow Cloud Build to deploy to Cloud Run using the application service account, grant the default Compute Engine service account (used by Cloud Build) the necessary roles:

```bash
PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')

# Allow Cloud Build to act as the App Service Account
gcloud iam service-accounts add-iam-policy-binding gcp-datanator-app-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com \
    --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
    --role="roles/iam.serviceAccountUser"

# Allow Cloud Build to deploy to Cloud Run
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
    --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
    --role="roles/run.admin"
```

---

## 🔑 Step 3: Environment Variables and Secrets

Store sensitive keys in **Secret Manager** for maximum security.

1.  **Create Secrets**:
    ```bash
    echo -n "YOUR_GEMINI_API_KEY" | gcloud secrets create GEMINI_API_KEY --data-file=-
    echo -n "YOUR_GOOGLE_CLIENT_ID" | gcloud secrets create GOOGLE_CLIENT_ID --data-file=-
    echo -n "YOUR_GOOGLE_CLIENT_SECRET" | gcloud secrets create GOOGLE_CLIENT_SECRET --data-file=-
    ```

2.  **Grant the Application Service Account access to the secrets**:
    ```bash
    for SECRET in GEMINI_API_KEY GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
      gcloud secrets add-iam-policy-binding $SECRET \
        --member="serviceAccount:gcp-datanator-app-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
        --role="roles/secretmanager.secretAccessor"
    done
    ```

---

## 📝 Step 4: Configure Deployment Variables (cloudbuild.yaml)

The deployment process is automated using `cloudbuild.yaml`. Before deploying, you can customize the deployment variables.

### 1. Default Variables (Automatic)
You **do not** need to define `$PROJECT_ID` or `$COMMIT_SHA` in the YAML file. Google Cloud Build automatically populates `$PROJECT_ID` based on the active `gcloud` project you set in the Prerequisites.

### 2. Custom Substitutions (Manual)
Open `cloudbuild.yaml` and look at the bottom `substitutions` block. You can change these values to match your preferred region, repository name, or service name:
```yaml
substitutions:
  _REGION: 'us-central1'
  _REPO_NAME: 'datanator-repo'
  _SERVICE_NAME: 'gcp-datanator'
  _SERVICE_ACCOUNT: 'gcp-datanator-app-sa'
```
*If you change these, ensure you use the same names in the previous steps when creating the Artifact Registry and Service Accounts.*

---

## 🚀 Step 5: Build and Deploy (One Command)

We have simplified the build and deployment process using `cloudbuild.yaml`. This file defines a pipeline that builds the Docker image, pushes it to Artifact Registry, and deploys it to Cloud Run with all the necessary volume mounts and secrets.

Run this single command from the root of your project:

```bash
gcloud builds submit --config cloudbuild.yaml .
```

> **💡 How it works:** 
> 1. Cloud Build reads `cloudbuild.yaml`.
> 2. It builds the image using `Dockerfile.txt`.
> 3. It pushes the image to Artifact Registry.
> 4. It deploys the image to Cloud Run, securely injecting the secrets from Secret Manager at runtime and mounting the GCS bucket for SQLite persistence.

---

## ⏱️ Step 6: Automate the ETL Pipeline (Cloud Scheduler)

Create a Cloud Scheduler job to trigger the sync automatically every **Sunday, Tuesday, and Friday at 2:00 AM**.

```bash
gcloud scheduler jobs create http gcp-datanator-sync \
  --schedule="0 2 * * 0,2,5" \
  --uri="https://YOUR_CLOUD_RUN_URL/api/v1/sync/monthly" \
  --http-method=POST \
  --oidc-service-account-email=gcp-datanator-scheduler-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --message-body='{"triggerType": "SCHEDULED"}' \
  --headers="Content-Type=application/json"
```
*(Replace `YOUR_CLOUD_RUN_URL` with the URL provided after the deployment step).*

---

## ⚙️ Step 7: Configure OAuth for GCS Export (Optional)

If you want to use the "Export to GCS" feature in the dashboard:

1.  Go to the **[APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials)** page.
2.  Click **Create Credentials > OAuth client ID** (Web application).
3.  Add your Cloud Run URL to **Authorized JavaScript origins**.
4.  Add `postmessage` to **Authorized redirect URIs**.
5.  Ensure the Client ID matches the `GOOGLE_CLIENT_ID` secret you set in Secret Manager.

---

## 🩺 Troubleshooting

### 1. "Read-only file system" error from SQLite
**Cause**: SQLite requires file locking which GCS FUSE (the volume mount) handles differently than local disk.
**Fix**: Ensure you are using `--execution-environment gen2`. The application is already configured with `PRAGMA journal_mode = WAL;` and `PRAGMA busy_timeout = 5000;` to mitigate this.

### 2. GCS Export fails with "Bucket not found"
**Cause**: The bucket name provided in the UI does not exist in the project, or the OAuth token lacks the `devstorage.read_write` scope.
**Fix**: Verify the bucket name in the GCP Console and ensure your OAuth consent screen includes the Storage API scopes.

### 3. Memory limit exceeded (OOM)
**Cause**: Processing many large RSS feeds concurrently.
**Fix**: Increase memory to 4Gi:
```bash
gcloud run services update gcp-datanator --memory=4Gi
```
