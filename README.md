# DropSend Signalling Server

Tiny signalling and presence server for DropSend.

## What it does
- Registers online devices by permanent device ID
- Answers exact ID presence lookups
- Routes incoming transfer requests to the recipient
- Relays WebRTC signalling messages only
- Does not store or relay file bytes

## Run locally
```bash
npm install
npm start
```

The server listens on `PORT` or `8080` by default.

## Health check
- `GET /health`

## Render deployment
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`

After deploy, copy your Render URL and use its WebSocket form in the app:
- `https://your-app.onrender.com` becomes `wss://your-app.onrender.com`
