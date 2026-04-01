# 🚀 Ultimate Guide: Deploying GCP Datanator to Cloud Run

This guide provides comprehensive, step-by-step instructions for deploying the **GCP Datanator** ETL pipeline and Admin Dashboard to Google Cloud Run using **Cloud Build** for a simplified, automated CI/CD pipeline.

## 🌟 Architecture & Production Readiness

This application is engineered for enterprise-grade production environments:
*   **Data Sources (Where the data comes from):** GCP Datanator automatically aggregates data from 10+ official Google Cloud and AI RSS/Atom feeds. This includes the main Google Cloud Blog, AI Research blog, Release Notes, Security Bulletins, and Service Health incidents. The ETL pipeline fetches, sanitizes, and deduplicates this data. You can view or modify these sources in `src/server/etl/extractor.ts`.
*   **Lightweight Container:** Uses a multi-stage `node:22-alpine` Docker build. The final image contains *only* production dependencies and compiled assets (no raw TypeScript files or dev tools).
*   **Security:** `npm ci --omit=dev` ensures no development dependencies are included in the runtime. The container runs with minimal privileges.
*   **Persistence (GCS Configuration):** Uses Google Cloud Storage (GCS) FUSE to mount a persistent volume (`/app/data`). This ensures the SQLite database (`gcp-datanator.db`) and the downloaded text feeds survive ephemeral container restarts.
*   **Concurrency & Stability:** SQLite is configured with `DELETE` journal mode (optimized for network mounts) and busy timeouts. Cloud Run is configured with `--max-instances 1` and `--no-cpu-throttling` to prevent database locks and ensure background ETL jobs complete successfully without being frozen by GCP.
*   **Cloud Native Logging:** The application writes all logs to `stdout`/`stderr`, which are automatically ingested by **Google Cloud Logging**. A strict 500-log rolling window is kept in SQLite for the Admin UI to prevent database bloat on the FUSE mount.

---

## 🛠️ Prerequisites

> ⚠️ **IMPORTANT: BEFORE YOU COPY/PASTE COMMANDS**
> Throughout this guide, you will see capitalized placeholder variables (like `YOUR_PROJECT_ID`). **Do not copy and paste these commands blindly.** You must replace these placeholders with your actual values before running the commands.
> 
> **Common Placeholders:**
> * `YOUR_PROJECT_ID`: Your actual Google Cloud Project ID (e.g., `my-company-data-123`).
> * `YOUR_CLOUD_RUN_URL`: The URL generated after you deploy the app (e.g., `gcp-datanator-abc123xyz-uc.a.run.app`).
> * `YOUR_GITHUB_REPO`: Your GitHub username and repository name (e.g., `octocat/my-repo`).
> * `YOUR_GEMINI_API_KEY`, `YOUR_GOOGLE_CLIENT_ID`, etc.: Your actual secret values.

1.  **Google Cloud Project**: A GCP project with billing enabled.
2.  **gcloud CLI**: Installed and authenticated (`gcloud auth login`).
3.  **Docker**: Installed and running on your local machine.
4.  **Set your active project**:
    ```bash
    gcloud config set project YOUR_PROJECT_ID
    ```
    *(Replace `YOUR_PROJECT_ID` with your actual project ID. This ensures all subsequent commands and Cloud Build automatically use the correct project).*
5.  **Required APIs Enabled**:
    ```bash
    gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com storage.googleapis.com artifactregistry.googleapis.com
    ```

---

## 📦 Step 1: Create GCS Bucket (for SQLite Persistence)

Cloud Run containers are stateless (their local file system is wiped when the container restarts). To persist the SQLite database and the downloaded feed files, you must mount a Google Cloud Storage (GCS) bucket. 

**How it works:** We use Cloud Storage FUSE to mount this bucket directly into the Cloud Run container at `/app/data`. This allows the application to write to the SQLite database (`/app/data/gcp-datanator.db`) and save the parsed feed files (`/app/data/feeds/*.txt`) exactly as if it were writing to a local hard drive, ensuring your data survives container restarts.

```bash
PROJECT_ID=$(gcloud config get-value project)
gcloud storage buckets create gs://${PROJECT_ID}-gcp-datanator-data --location=us-central1
```
*(The bucket name must be globally unique. This uses your project ID to ensure uniqueness).*

---

## 📦 Step 2: Create Artifact Registry Repository

Artifact Registry is where your built Docker images will be stored before being deployed to Cloud Run.
```bash
gcloud artifacts repositories create datanator-repo \
  --repository-format=docker \
  --location=us-central1 \
  --description="Docker repository for GCP Datanator"
```

---

## 🔐 Step 3: Service Accounts and Permissions

You need two service accounts: one for the application itself and one for the automated scheduler. You also need to grant Cloud Build permissions to deploy. By using dedicated service accounts, we follow the principle of least privilege.

### 1. Application Service Account
This account runs the Cloud Run service and needs access to the storage bucket.

```bash
PROJECT_ID=$(gcloud config get-value project)

# Create the service account
gcloud iam service-accounts create gcp-datanator-app-sa \
    --display-name="GCP Datanator Application Service Account"

# Grant storage access for the SQLite volume
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
    --member="serviceAccount:gcp-datanator-app-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/storage.objectAdmin"
```
*(This automatically uses your active project ID).*

### 2. Scheduler Service Account
This account triggers the monthly sync securely.

```bash
gcloud iam service-accounts create gcp-datanator-scheduler-sa \
    --display-name="GCP Datanator Scheduler Service Account"
```
*(Note: We will grant this account permission to invoke Cloud Run **after** the service is deployed in Step 7).*

### 3. Cloud Build Permissions
To allow Cloud Build to deploy to Cloud Run using the application service account, grant the default Compute Engine service account (used by Cloud Build) the necessary roles:

```bash
PROJECT_ID=$(gcloud config get-value project)
PROJECT_NUMBER=$(gcloud projects describe ${PROJECT_ID} --format='value(projectNumber)')

# Allow Cloud Build to act as the App Service Account
gcloud iam service-accounts add-iam-policy-binding gcp-datanator-app-sa@${PROJECT_ID}.iam.gserviceaccount.com \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/iam.serviceAccountUser"

# Allow Cloud Build to deploy to Cloud Run
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/run.admin"
```

---

## 🔑 Step 4: Environment Variables and Secrets

The application requires specific environment variables to function securely. We store these in **Secret Manager** to prevent hardcoding them.

### What are these secrets?
1. **`GEMINI_API_KEY`**: Required for the AI features (like summarizing incidents or generating tags). You can get this from [Google AI Studio](https://aistudio.google.com/app/apikey).
2. **`GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET`**: These are required for the **"Export to GCS"** feature in the dashboard. They allow the application to authenticate users via Google OAuth so they can securely export data to their own Google Cloud Storage buckets.

### How to create the Google OAuth Credentials:
If you don't plan to use the GCS Export feature, you can use a placeholder like `"TODO"` for these values. However, to fully enable the feature:

1. Go to the **[APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials)** page in your Google Cloud Console.
2. Click **Create Credentials > OAuth client ID**.
3. Choose **Web application** as the Application type.
4. Under **Authorized JavaScript origins**, add your Cloud Run URL (if you know it, otherwise you can add it later after deployment).
5. Under **Authorized redirect URIs**, add `postmessage` (since this app uses a popup-based OAuth flow).
6. Click **Create**. You will be given a **Client ID** and a **Client Secret**.

### Create the Secrets in Secret Manager:
Now, save these values into Secret Manager. **Make sure to replace the `YOUR_...` placeholders with your actual secret values**:

```bash
# 1. Save your Gemini API Key
echo -n "YOUR_ACTUAL_GEMINI_API_KEY" | gcloud secrets create GEMINI_API_KEY --data-file=-

# 2. Save your Google Client ID
echo -n "YOUR_ACTUAL_GOOGLE_CLIENT_ID" | gcloud secrets create GOOGLE_CLIENT_ID --data-file=-

# 3. Save your Google Client Secret
echo -n "YOUR_ACTUAL_GOOGLE_CLIENT_SECRET" | gcloud secrets create GOOGLE_CLIENT_SECRET --data-file=-
```

### Grant the Application Access:
Finally, allow the Cloud Run service account to read these secrets:
```bash
PROJECT_ID=$(gcloud config get-value project)

for SECRET in GEMINI_API_KEY GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:gcp-datanator-app-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

---

## 📝 Step 5: Configure Deployment Variables (cloudbuild.yaml)

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

## 🚀 Step 6: Build and Deploy (One Command)

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

### 🗄️ What `cloudbuild.yaml` automates for you:
Running SQLite in Cloud Run requires special configuration. By using the `cloudbuild.yaml` file, the following is handled automatically:
*   **Gen 2 Execution Environment:** Required for Cloud Storage FUSE.
*   **Volume Mounts:** Mounts your GCS bucket to `/app/data` inside the container.
*   **Single Instance Concurrency:** Sets `--max-instances=1` so multiple containers don't lock the SQLite database.
*   **No CPU Throttling:** Ensures background ETL jobs complete successfully.

---

## 🛠️ Alternative: Manual Deployment (Without Cloud Build)

If you prefer to build and deploy manually without using `cloudbuild.yaml`, you must include all the specific flags required for GCS FUSE and SQLite to work correctly.

1. **Build and push the image manually:**
```bash
PROJECT_ID=$(gcloud config get-value project)
gcloud builds submit --tag us-central1-docker.pkg.dev/${PROJECT_ID}/datanator-repo/gcp-datanator:latest -f Dockerfile.txt .
```

2. **Deploy with all required flags:**
```bash
PROJECT_ID=$(gcloud config get-value project)
gcloud run deploy gcp-datanator \
  --image=us-central1-docker.pkg.dev/${PROJECT_ID}/datanator-repo/gcp-datanator:latest \
  --region=us-central1 \
  --service-account=gcp-datanator-app-sa@${PROJECT_ID}.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --execution-environment=gen2 \
  --add-volume=name=data-vol,type=cloud-storage,bucket=${PROJECT_ID}-gcp-datanator-data \
  --add-volume-mount=volume=data-vol,mount-path=/app/data \
  --set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest,GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest \
  --set-env-vars=NODE_ENV=production \
  --port=3000 \
  --memory=2Gi \
  --cpu=1 \
  --max-instances=1 \
  --no-cpu-throttling
```

---

## ⏱️ Step 7: Automate the ETL Pipeline (Cloud Scheduler)

Now that the Cloud Run service is deployed, we need to grant the scheduler service account permission to invoke it, and then create the scheduled job.

### 1. Grant Invoker Permission
```bash
PROJECT_ID=$(gcloud config get-value project)

gcloud run services add-iam-policy-binding gcp-datanator \
    --region=us-central1 \
    --member="serviceAccount:gcp-datanator-scheduler-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/run.invoker"
```

### 2. Create the Scheduler Job
Create a Cloud Scheduler job to trigger the sync automatically every **Sunday, Tuesday, and Friday at 2:00 AM**.

```bash
PROJECT_ID=$(gcloud config get-value project)

gcloud scheduler jobs create http gcp-datanator-sync \
  --schedule="0 2 * * 0,2,5" \
  --uri="https://YOUR_CLOUD_RUN_URL/api/v1/sync/monthly?wait=true" \
  --http-method=GET \
  --oidc-service-account-email=gcp-datanator-scheduler-sa@${PROJECT_ID}.iam.gserviceaccount.com
```
*(Replace `YOUR_CLOUD_RUN_URL` with the URL provided after the deployment step).*

> **💡 Why `GET` and `?wait=true`?**
> Cloud Run throttles CPU to near zero immediately after an HTTP response is sent (unless "CPU always allocated" is enabled). By using `GET` with `?wait=true`, the API endpoint will wait for the background ETL process to complete *before* returning an HTTP 200 response. This ensures Cloud Run keeps the CPU active for the entire duration of the sync.

---

## 🔒 Step 8: Securing the Application (Optional but Recommended)

By default, the `cloudbuild.yaml` deploys the service with `--allow-unauthenticated`, meaning anyone on the internet can access the dashboard. For production, you should secure the application.

The recommended approach is to use **Identity-Aware Proxy (IAP)**:
1. Remove the `--allow-unauthenticated` flag from `cloudbuild.yaml` and redeploy.
2. Set up a Global External HTTP(S) Load Balancer pointing to your Cloud Run service.
3. Enable IAP on the Backend Service.
4. Grant the `IAP-secured Web App User` role to the Google Groups or users who should have access to the dashboard.

This ensures that only authorized users within your Google Workspace or specific Google accounts can access the dashboard, without needing to build custom authentication into the app itself.

---

## 🔄 Step 9: Continuous Deployment (GitHub Actions)

The repository includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) to automatically deploy to Cloud Run when you push to the `main` branch. 

To make this work, you must configure **Workload Identity Federation (WIF)**. This is the modern, secure way to authenticate GitHub Actions to Google Cloud without using long-lived JSON service account keys.

### 1. Set up Workload Identity Federation

Run these commands in your terminal (replace `YOUR_PROJECT_ID` and `YOUR_GITHUB_REPO` like `username/repo`):

```bash
export PROJECT_ID="YOUR_PROJECT_ID"
export REPO="YOUR_GITHUB_REPO" # e.g., "google-cloud/gcp-datanator"

# 1. Enable the IAM Credentials API
gcloud services enable iamcredentials.googleapis.com --project="${PROJECT_ID}"

# 2. Create a Workload Identity Pool
gcloud iam workload-identity-pools create "github-actions-pool" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --display-name="GitHub Actions Pool"

# 3. Create a Workload Identity Provider in that pool
gcloud iam workload-identity-pools providers create-oidc "github-actions-provider" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="github-actions-pool" \
  --display-name="GitHub Actions Provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
  --issuer-uri="https://token.actions.githubusercontent.com"

# 4. Allow the GitHub repository to impersonate the Application Service Account
# (Assuming you created gcp-datanator-app-sa in Step 2)
gcloud iam service-accounts add-iam-policy-binding "gcp-datanator-app-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$(gcloud projects describe ${PROJECT_ID} --format='value(projectNumber)')/locations/global/workloadIdentityPools/github-actions-pool/attribute.repository/${REPO}"
```

### 2. Add GitHub Repository Secrets

You need to add three secrets to your GitHub repository (**Settings > Secrets and variables > Actions > New repository secret**):

1. **`GCP_PROJECT_ID`**: Your Google Cloud Project ID.
2. **`WIF_SERVICE_ACCOUNT`**: The email of your service account (e.g., `gcp-datanator-app-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com`).
3. **`WIF_PROVIDER`**: The full identifier of the Workload Identity Provider. You can get this exact string by running:
   ```bash
   gcloud iam workload-identity-pools providers describe "github-actions-provider" \
     --project="${PROJECT_ID}" \
     --location="global" \
     --workload-identity-pool="github-actions-pool" \
     --format="value(name)"
   ```
   *(It will look something like: `projects/1234567890/locations/global/workloadIdentityPools/github-actions-pool/providers/github-actions-provider`)*

Once these secrets are added, your GitHub Action will authenticate successfully and deploy to Cloud Run!

---

## 🩺 Troubleshooting

### 1. "Read-only file system" error from SQLite
**Cause**: SQLite requires file locking which GCS FUSE (the volume mount) handles differently than local disk.
**Fix**: Ensure you are using `--execution-environment gen2`. The application is already configured with `PRAGMA journal_mode = DELETE;` and `PRAGMA busy_timeout = 10000;` to mitigate this.

### 2. GCS Export fails with "Bucket not found"
**Cause**: The bucket name provided in the UI does not exist in the project, or the OAuth token lacks the `devstorage.read_write` scope.
**Fix**: Verify the bucket name in the GCP Console and ensure your OAuth consent screen includes the Storage API scopes.

### 3. Memory limit exceeded (OOM)
**Cause**: Processing many large RSS feeds concurrently.
**Fix**: Increase memory to 4Gi:
```bash
gcloud run services update gcp-datanator --memory=4Gi
```

### 4. Docker build fails on sqlite3 installation
**Cause**: The `node:22-alpine` image might lack build tools if pre-built binaries for `sqlite3` are not available for your specific architecture.
**Fix**: The provided `Dockerfile.txt` already includes `RUN apk add --no-cache python3 make g++` to handle this. If you still encounter issues, try switching to a Debian-based image (e.g., `FROM node:22-slim`).
