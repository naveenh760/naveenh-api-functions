# Serverless Contact Form: GCP Cloud Function + SendGrid Setup Guide

This document is the complete, step-by-step reference for how the serverless email API for `naveenh.in` was built and deployed. It covers everything from GCP project setup to the final frontend integration.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [GCP Project Setup](#3-gcp-project-setup)
4. [Create a Service Account for CI/CD](#4-create-a-service-account-for-cicd)
5. [SendGrid Setup & Domain Authentication](#5-sendgrid-setup--domain-authentication)
6. [Node.js Cloud Function Code](#6-nodejs-cloud-function-code)
7. [GitHub Repository & Secrets](#7-github-repository--secrets)
8. [GitHub Actions CI/CD Pipeline](#8-github-actions-cicd-pipeline)
9. [Frontend Integration](#9-frontend-integration)
10. [Testing the Live API](#10-testing-the-live-api)
11. [Troubleshooting Reference](#11-troubleshooting-reference)

---

## 1. Architecture Overview

```
[naveenh.in frontend]
        |
        | HTTP POST (JSON)
        v
[Google Cloud Function (Gen 2)]   <-- Deployed via GitHub Actions
        |
        | SendGrid SDK (HTTPS)
        v
[SendGrid Email API]
        |
        | SMTP delivery
        v
[naveen.h760@gmail.com inbox]
```

**Why this approach?**
- The frontend is a static HTML site — it cannot securely hold API keys.
- The Cloud Function acts as a secure backend proxy that holds the SendGrid key in an environment variable.
- No servers to manage. GCP scales the function to zero when idle, so there are **no idle costs**.

---

## 2. Prerequisites

Before starting, ensure you have the following installed and configured locally:

| Tool | Purpose | Install |
|---|---|---|
| `gcloud` CLI | Manage GCP resources | [cloud.google.com/sdk](https://cloud.google.com/sdk/docs/install) |
| `node` >= 22 | Run the function locally | [nodejs.org](https://nodejs.org) |
| `npm` | Install dependencies | Included with Node.js |
| `git` | Push code to GitHub | [git-scm.com](https://git-scm.com) |
| `gh` CLI (optional) | Manage GitHub from terminal | [cli.github.com](https://cli.github.com) |

---

## 3. GCP Project Setup

### 3.1 Authenticate with GCP

```bash
gcloud auth login
gcloud config set project naveenh-platform
```

### 3.2 Enable Required APIs

The following APIs must be enabled on the project. Run this single command:

```bash
gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  iam.googleapis.com
```

> **Note:** Cloud Functions Gen 2 runs on top of Cloud Run internally, which is why `run.googleapis.com` is required.

---

## 4. Create a Service Account for CI/CD

GitHub Actions needs a service account with the right permissions to deploy the function automatically.

### 4.1 Create the Service Account

```bash
gcloud iam service-accounts create github-deployer \
  --display-name="GitHub Actions Deployer" \
  --project=naveenh-platform
```

### 4.2 Grant Required IAM Roles

```bash
export SA="github-deployer@naveenh-platform.iam.gserviceaccount.com"
export PROJECT="naveenh-platform"

# Deploy and manage Cloud Functions
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" \
  --role="roles/cloudfunctions.admin"

# Deploy and manage Cloud Run services (Gen 2 backend)
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" \
  --role="roles/run.admin"

# Allow deployer to act as the Cloud Run service account
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" \
  --role="roles/iam.serviceAccountUser"

# Push container images to Artifact Registry
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" \
  --role="roles/artifactregistry.writer"
```

### 4.3 Generate a JSON Key for GitHub

```bash
gcloud iam service-accounts keys create gcp-sa-key.json \
  --iam-account=$SA
```

> ⚠️ **Security Warning:** The `gcp-sa-key.json` file is a secret. Never commit it to Git.
> It is already added to `.gitignore`. You will upload its contents as a GitHub Secret in Step 7.

### 4.4 Allow Public (Unauthenticated) Invocations

Cloud Functions Gen 2 is backed by Cloud Run. To make the endpoint publicly accessible without an auth token, you must grant the `allUsers` invoker role on the Cloud Run service **after the first deployment**:

```bash
gcloud run services add-iam-policy-binding contactform \
  --region=us-central1 \
  --member="allUsers" \
  --role="roles/run.invoker"
```

> This is required because `allow_unauthenticated: true` in the GitHub Action may not always propagate correctly on the first deployment.

---

## 5. SendGrid Setup & Domain Authentication

### 5.1 Create a SendGrid Account

1. Go to [sendgrid.com](https://sendgrid.com) and sign up for a free account.
2. The free tier allows **100 emails/day** — sufficient for a contact form.

### 5.2 Authenticate Your Domain (naveenh.in)

To send from `contact@naveenh.in` (instead of a generic SendGrid address), you must prove domain ownership.

**In SendGrid:**
1. Navigate to **Settings → Sender Authentication → Authenticate a Domain**.
2. Choose your DNS provider (e.g., **GoDaddy**).
3. Enter your domain: `naveenh.in`.
4. SendGrid will generate a set of **CNAME records**.

**In GoDaddy DNS Manager** — Add these 3 CNAME records:

| Type | Name | Value |
|---|---|---|
| `CNAME` | `em1234.naveenh.in` | `u1234567.wl123.sendgrid.net` |
| `CNAME` | `s1._domainkey.naveenh.in` | `s1.domainkey.uXXXXXXX.wl123.sendgrid.net` |
| `CNAME` | `s2._domainkey.naveenh.in` | `s2.domainkey.uXXXXXXX.wl123.sendgrid.net` |

> The exact values are generated by SendGrid for your account. Use those.

Also add a DMARC TXT record to improve deliverability:

| Type | Name | Value |
|---|---|---|
| `TXT` | `_dmarc.naveenh.in` | `v=DMARC1; p=none; rua=mailto:naveen.h760@gmail.com` |

**Back in SendGrid:** Click **Verify** after DNS propagates (~15–30 min).

### 5.3 Create a SendGrid API Key

1. Navigate to **Settings → API Keys → Create API Key**.
2. Name it: `naveenh-contact-form`.
3. Permission: **Restricted Access → Mail Send → Full Access**.
4. Click **Create & View** and **copy the key immediately** — it is only shown once.

---

## 6. Node.js Cloud Function Code

### 6.1 Repository Structure

```
naveenh-api-functions/
├── .github/
│   └── workflows/
│       └── deploy.yml        # CI/CD pipeline
├── docs/
│   └── cloud-function-email-setup.md  # This document
├── index.js                  # Cloud Function entry point
├── package.json              # Node.js dependencies
└── .gitignore                # Excludes secrets and node_modules
```

### 6.2 package.json

```json
{
  "name": "naveenh-api-functions",
  "version": "1.0.0",
  "description": "Serverless utilities and APIs for naveenh.in",
  "main": "index.js",
  "scripts": {
    "start": "npx @google-cloud/functions-framework --target=contactForm",
    "dev": "npx @google-cloud/functions-framework --target=contactForm --port=8080"
  },
  "dependencies": {
    "@sendgrid/mail": "^8.1.3"
  },
  "devDependencies": {
    "@google-cloud/functions-framework": "^3.4.2"
  },
  "engines": {
    "node": ">=22"
  }
}
```

### 6.3 index.js — The Cloud Function

```javascript
const sgMail = require('@sendgrid/mail');

// Safelist of origins allowed to invoke this API
const ALLOWED_ORIGINS = [
  'https://naveenh.in',
  'https://www.naveenh.in',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://localhost:8080',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:3000'
];

exports.contactForm = async (req, res) => {
  const origin = req.headers.origin;

  // Dynamic CORS — only allow safelisted origins
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  } else {
    res.set('Access-Control-Allow-Origin', 'https://naveenh.in');
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight CORS OPTIONS requests
  if (req.method === 'OPTIONS') return res.status(204).send('');

  // Enforce POST only
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method Not Allowed.' });
  }

  const { name, email, subject, message } = req.body || {};

  // Input validation
  if (!name?.trim()) return res.status(400).json({ status: 'error', message: 'Name is required.' });
  if (!email?.trim() || !email.includes('@')) return res.status(400).json({ status: 'error', message: 'Valid email is required.' });
  if (!subject?.trim()) return res.status(400).json({ status: 'error', message: 'Subject is required.' });
  if (!message?.trim()) return res.status(400).json({ status: 'error', message: 'Message is required.' });

  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    console.error('SENDGRID_API_KEY is not set.');
    return res.status(500).json({ status: 'error', message: 'Server configuration error.' });
  }

  sgMail.setApiKey(apiKey);

  const emailPayload = {
    to: 'naveen.h760@gmail.com',
    from: 'contact@naveenh.in',      // Must be a SendGrid-verified sender
    replyTo: email.trim(),            // Replies go directly to the form submitter
    subject: `New Lead: ${subject.trim()}`,
    text: `Name: ${name}\nEmail: ${email}\n\nMessage:\n${message}`,
  };

  try {
    await sgMail.send(emailPayload);
    return res.status(200).json({ status: 'success', message: 'Your message has been sent successfully!' });
  } catch (error) {
    console.error('SendGrid error:', error.response?.body?.errors || error);
    return res.status(500).json({ status: 'error', message: 'Failed to send message. Please try again later.' });
  }
};
```

### 6.4 Local Development & Testing

Install dependencies:
```bash
npm install
```

Start the function locally on port 8080:
```bash
npm run dev
```

Test with `curl` in a second terminal:
```bash
curl -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com","subject":"Hello","message":"This is a test."}'
```

> Note: `SENDGRID_API_KEY` must be set in your shell environment for local testing to send real emails:
> `export SENDGRID_API_KEY="SG.your_key_here"`

---

## 7. GitHub Repository & Secrets

### 7.1 Push Code to GitHub

```bash
git init
git remote add origin https://github.com/naveenh760/naveenh-api-functions.git
git add .
git commit -m "feat: Initial Cloud Function setup"
git push -u origin main
```

### 7.2 Add GitHub Repository Secrets

Go to your GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**.

Add the following three secrets:

| Secret Name | Value | Where to get it |
|---|---|---|
| `GCP_PROJECT_ID` | `naveenh-platform` | Your GCP project ID |
| `GCP_SA_KEY` | *(full contents of `gcp-sa-key.json`)* | Copy-paste the entire JSON file content |
| `SENDGRID_API_KEY` | `SG.xxxxxxxxxxxxxxxx` | From SendGrid API Keys page (Step 5.3) |

---

## 8. GitHub Actions CI/CD Pipeline

The file at `.github/workflows/deploy.yml` automates every deployment on every push to `main`.

```yaml
name: Deploy to Google Cloud Functions

on:
  push:
    branches:
      - main

env:
  PROJECT_ID: ${{ secrets.GCP_PROJECT_ID }}
  REGION: us-central1
  FUNCTION_NAME: contactForm
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

jobs:
  deploy:
    name: Build & Deploy
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Authenticate to GCP
        uses: google-github-actions/auth@v3
        with:
          credentials_json: ${{ secrets.GCP_SA_KEY }}

      - name: Deploy to Cloud Functions
        uses: google-github-actions/deploy-cloud-functions@v3
        with:
          name: ${{ env.FUNCTION_NAME }}
          runtime: nodejs22
          region: ${{ env.REGION }}
          entry_point: contactForm
          environment: GEN_2
          allow_unauthenticated: true
          environment_variables: SENDGRID_API_KEY=${{ secrets.SENDGRID_API_KEY }}
```

> ⚠️ **Critical Note:** The action input is `environment_variables` (not `env_vars`). This was renamed in `deploy-cloud-functions@v3`. Using `env_vars` silently fails and the secret will not be injected into the container.

---

## 9. Frontend Integration

In your static website's `script.js`, intercept the form submit event and call the deployed Cloud Function URL instead of a native browser form submission:

```javascript
function initForm() {
    const contactForm = document.getElementById('contact-form');
    const formStatus = document.getElementById('form-status');

    if (contactForm) {
        contactForm.addEventListener('submit', async function(e) {
            e.preventDefault();

            const submitBtn = document.getElementById('submit-btn');
            const originalContent = submitBtn.innerHTML;
            submitBtn.innerHTML = '<span>Sending...</span>';
            submitBtn.disabled = true;
            formStatus.textContent = '';
            formStatus.className = 'form-status';

            const formData = {
                name: document.getElementById('name').value,
                email: document.getElementById('email').value,
                subject: document.getElementById('subject').value,
                message: document.getElementById('message').value
            };

            try {
                const response = await fetch('https://contactform-3jr2ju7rna-uc.a.run.app', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(formData)
                });

                const result = await response.json();

                if (response.ok) {
                    formStatus.textContent = 'Message sent successfully! I will get back to you soon.';
                    formStatus.className = 'form-status success';
                    contactForm.reset();
                } else {
                    formStatus.textContent = result.message || 'Something went wrong. Please try again.';
                    formStatus.className = 'form-status error';
                }
            } catch (error) {
                console.error('Submission Error:', error);
                formStatus.textContent = 'Failed to connect to the server. Please try again later.';
                formStatus.className = 'form-status error';
            } finally {
                submitBtn.innerHTML = originalContent;
                submitBtn.disabled = false;
            }
        });
    }
}

// Call this inside your DOMContentLoaded listener
document.addEventListener('DOMContentLoaded', () => {
    initForm();
});
```

> **Important:** The `initForm()` call **must** be inside `DOMContentLoaded` to ensure the `#contact-form` element exists in the DOM before the JavaScript tries to bind the event listener. Calling it at the top level of a `<script src="script.js">` at the bottom of `<body>` also works but is less robust.

---

## 10. Testing the Live API

After every deployment, verify the function is healthy using `curl`:

```bash
# Test from an allowed origin
curl -i -X POST https://contactform-3jr2ju7rna-uc.a.run.app \
  -H "Content-Type: application/json" \
  -H "Origin: https://naveenh.in" \
  -d '{"name":"Test User","email":"test@example.com","subject":"Test","message":"Hello from curl!"}'

# Expected response:
# HTTP/2 200
# {"status":"success","message":"Your message has been sent successfully!"}
```

### Viewing Logs

To debug issues in the live function, stream the Cloud Run logs:

```bash
gcloud run services logs read contactform \
  --region us-central1 \
  --project naveenh-platform \
  --limit 50
```

Or view them in real-time:

```bash
gcloud beta run services logs tail contactform \
  --region us-central1 \
  --project naveenh-platform
```

---

## 11. Troubleshooting Reference

| Symptom | Root Cause | Fix |
|---|---|---|
| `403 Forbidden` on first deploy | `allUsers` invoker permission not set on the Cloud Run service | Run the `gcloud run services add-iam-policy-binding` command in Step 4.4 |
| `500` error, logs show `SENDGRID_API_KEY is not set` | Wrong YAML key `env_vars` used instead of `environment_variables` | Use `environment_variables` in `deploy.yml` (v3 action rename) |
| `403 Permission Denied` during GitHub Actions deploy | Service account missing IAM roles | Add all four roles listed in Step 4.2 |
| Email not arriving after `200 OK` | SendGrid domain not verified, or sending from unverified sender | Complete domain authentication in Step 5.2 and verify CNAME records |
| Form submits but nothing happens visually | `initForm()` called outside `DOMContentLoaded` | Wrap `initForm()` call inside a `DOMContentLoaded` listener |
| Old JS still running after code change | Browser has cached old `script.js` | Add `?v=N` cache-buster to `<script src="script.js?v=2">` in `index.html` |

---

## Key Resources

- **GCP Project:** `naveenh-platform`
- **Cloud Function Name:** `contactForm`
- **Live Endpoint:** `https://contactform-3jr2ju7rna-uc.a.run.app`
- **Deployed Region:** `us-central1`
- **SendGrid Verified Domain:** `naveenh.in`
- **From Email:** `contact@naveenh.in`
- **Destination Inbox:** `naveen.h760@gmail.com`
- **GitHub Repo:** `naveenh760/naveenh-api-functions`
