# VigilPR - Setup Guide

VigilPR is an AI-powered GitHub Pull Request review and security audit bot. This guide walks you through setting up the GitHub App permissions, configuring environment variables, forwarding local webhooks with `smee.io` or `ngrok`, running the local Inngest Dev Server, and orchestrating durable background reviews.

---

## 1. Prerequisites

- **Node.js**: v18.18.0 or later (v20+ recommended)
- **npm** / **pnpm** / **yarn**
- **OpenAI API Key**: Required for generating AI-powered code reviews (`gpt-4o-mini` or `gpt-4o`)

---

## 2. GitHub App Configuration

1. In GitHub, navigate to **Settings** > **Developer Settings** > **GitHub Apps** > [**New GitHub App**](https://github.com/settings/apps/new).
2. Configure basic application details:
   - **GitHub App name**: `VigilPR-Dev` (or a unique name of your choice).
   - **Homepage URL**: `http://localhost:3000` (or your repository URL).
3. **Webhook Setup**:
   - Check **Active**.
   - **Webhook URL**: Enter your `smee.io` or `ngrok` URL pointing to `/api/webhooks/github` (see [Section 4](#4-local-webhook-forwarding)).
   - **Webhook secret**: Enter a strong secret string (e.g. generate via `openssl rand -hex 20`).
4. **Repository Permissions**:
   Configure the following permissions under **Permissions & events**:
   - **Pull requests**: `Read and write`
     > **CRITICAL**: The `Read and write` permission is strictly required for VigilPR to submit batched review summaries and line-specific inline comments/suggestions via `octokit.rest.pulls.createReview`.
   - **Contents**: `Read-only`
     *(Allows reading repository files, tree objects, commit references, and diffs)*
5. **Subscribe to Events**:
   Under **Subscribe to events**, select:
   - [x] **Pull request**
6. Click **Create GitHub App**.
7. In the app settings page:
   - Note down the **App ID** (shown under General).
   - Scroll down to **Private keys** and click **Generate a private key**.
   - Save the downloaded `.pem` file securely.
8. Install the App:
   - On the left sidebar, click **Install App**.
   - Install the app onto your personal account or organization, selecting either all repositories or specific test repositories.

---

## 3. Environment Variables Configuration

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

Fill in the variables in `.env.local`:

```env
# GitHub App Authentication
GITHUB_APP_ID="123456"
GITHUB_WEBHOOK_SECRET="your_webhook_secret_here"

# Paste the contents of your downloaded .pem private key file.
# Escaped literal \n sequences or multiline PEM strings are safely supported.
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"

# OpenAI API Key for AI Review Engine
OPENAI_API_KEY="sk-..."

# Optional: Override the model used (defaults to gpt-4o-mini)
VIGILPR_MODEL="gpt-4o-mini"

# Inngest Background Keys (Optional in local development; required in production)
# INNGEST_EVENT_KEY="your_inngest_event_key"
# INNGEST_SIGNING_KEY="your_inngest_signing_key"
```

---

## 4. Local Webhook Forwarding

To receive GitHub webhooks locally while developing, use either **smee.io** (recommended by GitHub) or **ngrok**.

### Option A: Using Smee.io (Recommended)

1. Go to [https://smee.io](https://smee.io) and click **"Start a new channel"**.
2. Copy your unique channel URL (e.g. `https://smee.io/AbCdEfGh123456`).
3. Set your GitHub App **Webhook URL** to this exact smee.io URL.
4. Run the Smee forwarding client locally:

```bash
npx smee -u https://smee.io/AbCdEfGh123456 --target http://localhost:3000/api/webhooks/github
```

### Option B: Using Ngrok

1. Start an HTTP tunnel to port 3000:

```bash
ngrok http 3000
```

2. Copy the generated forwarding HTTPS URL (e.g. `https://1234-56-78.ngrok-free.app`).
3. Set your GitHub App **Webhook URL** to:
   ```
   https://1234-56-78.ngrok-free.app/api/webhooks/github
   ```

---

## 5. Running the Pipeline Locally

In local development, run the following 3 processes:

### Terminal 1: Start Next.js Development Server
```bash
npm run dev
```
*(Runs at `http://localhost:3000`)*

### Terminal 2: Start Inngest Dev Server
```bash
npx --ignore-scripts=false inngest-cli@latest dev -u http://localhost:3000/api/inngest
```
*(Inngest Dashboard available at `http://localhost:8288`)*

### Terminal 3: Start Webhook Forwarding
```bash
npx smee -u https://smee.io/YOUR_CHANNEL_ID --target http://localhost:3000/api/webhooks/github
```

---

## 6. How the 4-Step Pipeline Works

When a PR is opened or updated (`synchronize`):
1. **Webhook Ingestion (`/api/webhooks/github`)**: Verifies HMAC-SHA256 signature, validates the payload with Zod, emits `vigilpr/pr.review.requested` to Inngest, and responds with `202 Accepted` immediately within milliseconds (preventing GitHub's 10-second webhook timeout).
2. **Idempotency & Auto-Cancellation (Inngest)**:
   - **Idempotency**: Keyed on `owner/repo#pr@commitSha` to avoid duplicate reviews for the same commit.
   - **Auto-Cancellation**: If a new commit is pushed (`synchronize`) while an older review is running, `cancelOn` automatically halts the stale run.
   - **Concurrency**: Limited to 5 concurrent runs to avoid API rate limits.
3. **Step 1 (Diff Filtering & Line Mapping)**: `step.run('fetch-and-prepare-diffs')` filters non-code assets and maps exact new-file (`RIGHT`-side) line numbers.
4. **Step 2 (AI Review Engine)**: `step.run('generate-ai-review')` produces structured JSON review feedback and validates line numbers post-LLM.
5. **Step 3 (GitHub Posting)**: `step.run('post-github-review')` posts a batched review with inline suggestions and severity badges back to GitHub.
