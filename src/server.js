import "dotenv/config";
import crypto from "node:crypto";
import http from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_TOKEN = process.env.QBIT_ADMIN_TOKEN;
const DB_PATH = process.env.QBIT_DB_PATH || "./data/qbit.sqlite";
const allowedOrigins = (process.env.CORS_ORIGINS || "").split(",").map(v => v.trim()).filter(Boolean);

if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 32) {
  console.error("Set QBIT_ADMIN_TOKEN to a random secret of at least 32 characters.");
  process.exit(1);
}

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen TEXT
  );
  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    action TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL,
    completed_at TEXT,
    result TEXT,
    FOREIGN KEY(device_id) REFERENCES devices(id)
  );
`);

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed by CORS"));
  }
}));
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const connected = new Map();

const now = () => new Date().toISOString();
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const bearer = req => req.headers.authorization?.startsWith("Bearer ")
  ? req.headers.authorization.slice(7) : "";
const requireAdmin = (req, res, next) => {
  if (!safeEqual(bearer(req), ADMIN_TOKEN)) return res.status(401).json({ error: "unauthorized" });
  next();
};
const findDevice = id => db.prepare("SELECT id, name, platform, created_at, last_seen FROM devices WHERE id = ?").get(id);

app.get("/health", (_req, res) => res.json({ ok: true, service: "qbit-api", time: now() }));

app.post("/v1/devices/register", requireAdmin, (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 80);
  const platform = String(req.body?.platform || "").trim().toLowerCase();
  if (!name || !["web", "windows", "android"].includes(platform)) {
    return res.status(400).json({ error: "name and platform (web, windows, android) are required" });
  }
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO devices (id, name, platform, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, name, platform, sha256(token), now());
  res.status(201).json({ device: findDevice(id), token, warning: "Save this token securely. It will not be shown again." });
});

app.get("/v1/devices", requireAdmin, (_req, res) => {
  const devices = db.prepare("SELECT id, name, platform, created_at, last_seen FROM devices ORDER BY created_at DESC").all();
  res.json({ devices });
});

app.delete("/v1/devices/:id", requireAdmin, (req, res) => {
  const device = findDevice(req.params.id);
  if (!device) return res.status(404).json({ error: "device_not_found" });
  connected.get(device.id)?.close(4001, "Device revoked");
  connected.delete(device.id);
  db.prepare("DELETE FROM commands WHERE device_id = ?").run(device.id);
  db.prepare("DELETE FROM devices WHERE id = ?").run(device.id);
  res.json({ ok: true });
});

app.post("/v1/devices/:id/commands", requireAdmin, (req, res) => {
  const device = findDevice(req.params.id);
  if (!device) return res.status(404).json({ error: "device_not_found" });
  const action = String(req.body?.action || "").trim().slice(0, 80);
  const payload = req.body?.payload ?? {};
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(action)) {
    return res.status(400).json({ error: "invalid_action" });
  }
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO commands (id, device_id, action, payload, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)")
    .run(id, device.id, action, JSON.stringify(payload), now());
  const socket = connected.get(device.id);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "command", id, action, payload }));
    db.prepare("UPDATE commands SET status = 'sent' WHERE id = ?").run(id);
  }
  res.status(202).json({ id, device_id: device.id, status: socket?.readyState === WebSocket.OPEN ? "sent" : "queued" });
});

app.get("/v1/commands/:id", requireAdmin, (req, res) => {
  const command = db.prepare("SELECT id, device_id, action, payload, status, created_at, completed_at, result FROM commands WHERE id = ?").get(req.params.id);
  if (!command) return res.status(404).json({ error: "command_not_found" });
  res.json({ ...command, payload: JSON.parse(command.payload), result: command.result ? JSON.parse(command.result) : null });
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname !== "/v1/connect") return socket.destroy();
  wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws));
});

wss.on("connection", ws => {
  let deviceId = null;
  const authTimeout = setTimeout(() => ws.close(4003, "Authentication timeout"), 5000);

  ws.on("message", raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return ws.close(4002, "Invalid JSON"); }

    if (!deviceId) {
      if (message.type !== "auth" || typeof message.token !== "string") return ws.close(4003, "Authentication required");
      const device = db.prepare("SELECT id, token_hash FROM devices WHERE token_hash = ?").get(sha256(message.token));
      if (!device) return ws.close(4003, "Invalid device token");
      deviceId = device.id;
      clearTimeout(authTimeout);
      connected.get(deviceId)?.close(4004, "Replaced by a newer connection");
      connected.set(deviceId, ws);
      db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(now(), deviceId);
      ws.send(JSON.stringify({ type: "connected", device_id: deviceId }));
      return;
    }

    if (message.type === "heartbeat") {
      db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(now(), deviceId);
      return;
    }
    if (message.type === "command_result" && typeof message.id === "string") {
      const command = db.prepare("SELECT id FROM commands WHERE id = ? AND device_id = ?").get(message.id, deviceId);
      if (!command) return;
      db.prepare("UPDATE commands SET status = ?, completed_at = ?, result = ? WHERE id = ?")
        .run(message.ok ? "completed" : "failed", now(), JSON.stringify(message.result ?? null), message.id);
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimeout);
    if (deviceId && connected.get(deviceId) === ws) connected.delete(deviceId);
  });
  ws.on("error", () => {});
});

server.listen(PORT, HOST, () => console.log(`QBIT API listening on ${HOST}:${PORT}`));
