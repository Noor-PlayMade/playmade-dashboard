# Playmade Support Dashboard

A live Intercom support dashboard deployable on Vercel.

## Setup (5 minutes)

### 1. Deploy to Vercel
1. Go to [vercel.com](https://vercel.com) and click **Add New → Project**
2. Click **"Import Third-Party Git Repository"** or drag & drop this folder
3. Keep all settings as default and click **Deploy**

### 2. Add Environment Variables
In your Vercel project → **Settings → Environment Variables**, add:

| Variable | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | Your key from console.anthropic.com |
| `INTERCOM_ACCESS_TOKEN` | Your Intercom access token (see below) |

### 3. Get your Intercom Access Token
1. Go to [app.intercom.com/a/apps/uf97uhs1/settings/app-settings](https://app.intercom.com/a/apps/uf97uhs1/settings/app-settings)
2. Scroll to **"Access Token"** under the "Your App" section
3. Copy the token and paste it as `INTERCOM_ACCESS_TOKEN`

### 4. Redeploy
After adding the environment variables, go to **Deployments → Redeploy** (or just push any change).

### 5. Embed in Notion
1. Copy your Vercel deployment URL (e.g. `https://playmade-dashboard.vercel.app`)
2. Open your Notion dashboard page
3. Type `/embed`, paste the URL, press Enter
4. Resize the embed to fill the page

## Usage
- Use the **day tabs** to switch between the last 7 days
- Use the **date picker** for any custom date
- Click **Refresh** to pull the latest data
- The dashboard auto-loads on page open
