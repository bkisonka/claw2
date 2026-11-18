# claw2 Web UI

Web interface: chat and config settings. React + TypeScript, Vite.

## Install and run

```bash
npm install
npm run dev    # dev server at http://localhost:5173, proxy to gateway :3000
npm run build  # build to dist/
```

Before starting the UI, start the gateway: from the repo root `npm run gateway` (port 3000).

## Environment variables

- `VITE_API_URL` — base API URL (default empty = same origin, for proxy).
- `VITE_API_KEY` — API key for auth (if gateway has auth enabled).

## Settings

The “Settings” screen: load config (GET /api/config), edit main fields (LLM, Gateway, memory), “Save” and “Save and restart” buttons. After saving, the config is written to the file; for changes to take effect, the gateway must be restarted (“Restart now” button or restart the container in Docker).
