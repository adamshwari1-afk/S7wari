# S7wari — Editorial Workspace

Full-stack Node.js + React web application for fetching articles, optionally rewriting them with Google Gemini, splitting content into WordPress `<!--nextpage-->` pages, uploading images to the WordPress Media Library, and publishing or saving drafts via the WordPress REST API.

---

## Requirements

- **Node.js 20+ LTS** (20.x or 22.x recommended)
- **npm**
- One or more WordPress sites with **Application Passwords** enabled
- A **Google Gemini API key** (`GEMINI_API_KEY`) if using **AI rewrite** mode (Copy mode runs without any AI calls)

---

## Environment Variables

Copy `.env.example` to `.env` for local runs, or configure these variables in your Hostinger Web App settings:

| Variable | Required | Description |
| :--- | :--- | :--- |
| `PORT` | No | Port the Express server listens on. Hostinger sets this automatically; falls back to `3000`. |
| `NODE_ENV` | Recommended | Set to `production` when deployed. |
| `GEMINI_API_KEY` | For AI mode | Direct Google Gemini API key (`@google/genai`). Not needed if you only use Copy mode. |
| `OWNER_EMAIL` | Optional | Locks owner login email via environment variable. |
| `OWNER_PASSWORD` | Optional | Locks owner login password via environment variable. If omitted, you can create the owner account on first launch in the app UI. |
| `SESSION_SECRET` | Recommended | Random secret (32+ chars) used to sign login tokens so sessions persist across server restarts. |
| `DATA_DIR` | Optional | Directory path for `s7wari.json` storage. Defaults to `./data` (created automatically if missing). |

> **Security note:** WordPress Application Passwords and owner password hashes are stored server-side inside `data/s7wari.json` and are never sent to the browser.

---

## Local Production Build & Test

```bash
npm install
npm run build
npm start
```

- `npm run build` builds the React frontend into `dist/` and bundles the Express backend into `server.js`.
- `npm start` launches the compiled production server with `node server.js` (no Vite dev server).

---

## Deploying to Hostinger (hPanel > Create site > Web App)

### 1. Prepare Your Repository or Project Files
Push this project to a Git repository (GitHub/GitLab/Bitbucket), or prepare a `.zip` archive of the project excluding `node_modules/`, `dist/`, `.env`, and `data/` (keep `server.js`, `package.json`, `package-lock.json`, and `.npmrc`).

### 2. Create the Node.js Web App in Hostinger hPanel
1. Log in to **Hostinger hPanel**.
2. Go to **Websites** -> **Create site** (or **Add website**).
3. Choose **Node.js Web App** (or **Web App** -> **Node.js**).
4. Connect your Git repository (recommended) or upload your project files.

### 3. Configure Build & Start Settings
In the Hostinger Web App configuration:
- **Node.js version:** `20 LTS` (or `22 LTS`)
- **Entry file:** `server.js`
- **Build command:**
  ```bash
  npm install && npm run build
  ```
- **Start command:**
  ```bash
  npm start
  ```
  *(Runs `node server.js`)*
- **Root / Application directory:** Project root (where `package.json` and `server.js` live).

### 4. Add Environment Variables in hPanel
Open your Web App's **Environment Variables** section and add:
- `NODE_ENV` = `production`
- `SESSION_SECRET` = *(generate a long random string, e.g. 32+ characters)*
- `GEMINI_API_KEY` = *(your Google Gemini API key, if using AI rewrite mode)*
- Optional: `OWNER_EMAIL` and `OWNER_PASSWORD` (if you want login locked to environment variables instead of the first-run setup page)

> Do **not** hardcode `PORT` unless instructed by Hostinger—Hostinger injects `PORT` automatically and the server falls back to `3000`.

### 5. Deploy & Verify
1. Trigger **Deploy / Build** in hPanel.
2. Once live, open `https://your-domain.com/api/health` — it should return `{"ok":true}`.
3. Visit `https://your-domain.com` and either complete the first-run owner setup (if `OWNER_PASSWORD` is unset) or sign in with your configured credentials.
4. Go to **Settings** -> **Add destination** to connect your WordPress site(s) using a WordPress username and Application Password (`Users > Profile > Application Passwords` in WordPress).

### 6. Persistent Storage (`data/s7wari.json`)
Settings, WordPress destinations, and job history are saved in `./data/s7wari.json` (created automatically on first start). If your deployment pipeline replaces the app folder on every deploy, configure `DATA_DIR` to point to a persistent directory outside the release folder so your settings and history are preserved across redeployments.
