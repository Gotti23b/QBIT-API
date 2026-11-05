# QBIT API

Central communication service for QBIT Web, Windows and Android.

## What is included

- REST API for registering, listing and revoking QBIT devices.
- Per-device random credentials (only the SHA-256 hash is stored).
- WebSocket connections for real-time device communication.
- A command queue and command-result tracking.
- SQLite persistence for devices and commands.
- Basic security headers, JSON size limit and configurable CORS.

## Requirements

- Node.js 20+
- A persistent disk for the SQLite database in hosted environments.

## Run locally

```bash
npm install
cp .env.example .env
```

Set `QBIT_ADMIN_TOKEN` in `.env` to a unique random secret of at least 32 characters, then:

```bash
npm run check
npm start
```

Health check: `GET http://localhost:3000/health`

## Authentication model

Administrative routes require:

```
Authorization: Bearer YOUR_QBIT_ADMIN_TOKEN
```

**Never put the admin token in browser JavaScript, a public repository, or a desktop/mobile app.** The web frontend must call its own trusted backend, which then calls this API. Device apps receive their own device token.

## API routes

| Method | Route | Purpose | Authentication |
|---|---|---|---|
| GET | `/health` | Service health | None |
| POST | `/v1/devices/register` | Register a device | Admin |
| GET | `/v1/devices` | List devices | Admin |
| DELETE | `/v1/devices/:id` | Revoke a device | Admin |
| POST | `/v1/devices/:id/commands` | Queue/send a command | Admin |
| GET | `/v1/commands/:id` | Read command status/result | Admin |
| WebSocket | `/v1/connect` | Persistent device connection | Device token in first message |

### Register a device

```http
POST /v1/devices/register
Authorization: Bearer YOUR_QBIT_ADMIN_TOKEN
Content-Type: application/json

{
  "name": "Thiago's PC",
  "platform": "windows"
}
```

Supported platforms: `web`, `windows`, `android`.

The response contains a device token **once**. Store it securely on that device.

### Connect a device

Open a WebSocket to `/v1/connect`, then send:

```json
{ "type": "auth", "token": "DEVICE_TOKEN" }
```

The server responds with `connected`. The device can send `heartbeat` messages and `command_result` messages. Commands arrive as `command` messages.

### Send a command

```http
POST /v1/devices/DEVICE_ID/commands
Authorization: Bearer YOUR_QBIT_ADMIN_TOKEN
Content-Type: application/json

{
  "action": "system_info",
  "payload": {}
}
```

This service only transports named actions and payloads. A QBIT client must validate each action against its own allowlist and ask for local confirmation when an operation is sensitive. Do not implement arbitrary shell execution from API messages.

## Deployment notes

Deploy as a persistent Node.js service, not as a static GitHub Pages site. Configure the environment variables in the hosting provider and attach persistent storage for `QBIT_DB_PATH`. Use HTTPS/WSS in production and set `CORS_ORIGINS` to the exact trusted web origins.

This is the initial API foundation, not a complete public production account system. Before exposing it publicly, add user authentication, rate limiting, audit logs, device pairing/approval UI, backup/restore and monitoring. The API admin token must remain server-side.
