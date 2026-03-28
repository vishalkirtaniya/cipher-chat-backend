/**
 * CipherChat Signaling Server
 * Handles: register, message, message_request, request_accepted,
 *          request_declined, receipt, delete_message, typing, ping
 * Never stores messages. Routes ciphertext only.
 */

import { WebSocketServer } from "ws";
import http from "http";

const PORT = process.env.PORT || 8080;
const clients = new Map();           // userId → { ws, publicKey, lastSeen }
const offlineQueue = new Map();      // userId → [envelope]
const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QUEUE_PER_USER = 500;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", connectedClients: clients.size, uptime: process.uptime() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let userId = null;
  let heartbeatTimer = null;

  const send = (data) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  };

  const resetHeartbeat = () => {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      console.log(`[heartbeat] Terminating idle: ${userId}`);
      ws.terminate();
    }, 35000);
  };

  // Forward a payload to a user — queue if offline
  const forward = (toUserId, envelope, ttl) => {
    if (clients.has(toUserId) && clients.get(toUserId).ws.readyState === 1) {
      clients.get(toUserId).ws.send(JSON.stringify(envelope));
      return true;
    }
    queueOfflineMessage(toUserId, envelope, ttl);
    return false;
  };

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { send({ type: "error", code: "INVALID_JSON" }); return; }

    switch (msg.type) {

      case "register": {
        if (!msg.userId || !msg.publicKey) {
          send({ type: "error", code: "MISSING_FIELDS" }); return;
        }
        if (clients.has(msg.userId)) {
          const ex = clients.get(msg.userId);
          if (ex.ws !== ws && ex.ws.readyState === 1) ex.ws.close(4000, "Replaced");
        }
        userId = msg.userId;
        clients.set(userId, { ws, publicKey: msg.publicKey, lastSeen: Date.now() });
        console.log(`[register] ${userId} (${clients.size} online)`);
        send({ type: "registered", userId, serverTime: Date.now() });
        flushOfflineQueue(userId);
        resetHeartbeat();
        break;
      }

      case "ping": {
        if (clients.has(userId)) clients.get(userId).lastSeen = Date.now();
        send({ type: "pong", serverTime: Date.now() });
        resetHeartbeat();
        break;
      }

      // ── Encrypted message (contacts only) ──────────────────────────────────
      case "message": {
        if (!userId) { send({ type: "error", code: "NOT_REGISTERED" }); return; }
        const { to, from, messageId, payload, timestamp, ttl } = msg;
        if (!to || !from || !messageId || !payload) {
          send({ type: "error", code: "MISSING_FIELDS" }); return;
        }
        send({ type: "ack", messageId, status: "server_received", serverTime: Date.now() });
        const envelope = { type: "message", from, messageId, payload, timestamp, ttl };
        const delivered = forward(to, envelope, ttl);
        send({ type: "ack", messageId, status: delivered ? "delivered" : "queued", serverTime: Date.now() });
        break;
      }

      // ── Message request (no prior contact, plaintext intro) ─────────────────
      // Sender sends: { type, to, from, fromDisplayName, fromPublicKey, requestId, previewText }
      case "message_request": {
        if (!userId) { send({ type: "error", code: "NOT_REGISTERED" }); return; }
        const { to, from, fromDisplayName, fromPublicKey, requestId, previewText, timestamp } = msg;
        if (!to || !from || !requestId || !previewText || !fromPublicKey) {
          send({ type: "error", code: "MISSING_FIELDS" }); return;
        }
        send({ type: "ack", messageId: requestId, status: "server_received", serverTime: Date.now() });
        const envelope = { type: "message_request", from, fromDisplayName, fromPublicKey, requestId, previewText, timestamp };
        const delivered = forward(to, envelope, QUEUE_TTL_MS);
        send({ type: "ack", messageId: requestId, status: delivered ? "delivered" : "queued", serverTime: Date.now() });
        console.log(`[request] ${from} → ${to} (${delivered ? "delivered" : "queued"})`);
        break;
      }

      // ── Request accepted — receiver sends their public key back ─────────────
      case "request_accepted": {
        if (!userId) { send({ type: "error", code: "NOT_REGISTERED" }); return; }
        const { to, from, fromDisplayName, fromPublicKey, requestId, timestamp } = msg;
        const envelope = { type: "request_accepted", from, fromDisplayName, fromPublicKey, requestId, timestamp };
        forward(to, envelope, QUEUE_TTL_MS);
        console.log(`[accept] ${from} accepted request from ${to}`);
        break;
      }

      // ── Request declined ────────────────────────────────────────────────────
      case "request_declined": {
        if (!userId) { send({ type: "error", code: "NOT_REGISTERED" }); return; }
        const { to, from, requestId } = msg;
        forward(to, { type: "request_declined", from, requestId, timestamp: Date.now() }, QUEUE_TTL_MS);
        console.log(`[decline] ${from} declined request from ${to}`);
        break;
      }

      case "receipt": {
        if (!userId) { send({ type: "error", code: "NOT_REGISTERED" }); return; }
        forward(msg.to, { type: "receipt", from: userId, messageIds: msg.messageIds, status: msg.status, timestamp: Date.now() }, QUEUE_TTL_MS);
        break;
      }

      case "delete_message": {
        if (!userId) { send({ type: "error", code: "NOT_REGISTERED" }); return; }
        forward(msg.to, { type: "delete_message", from: userId, messageIds: msg.messageIds, timestamp: Date.now() }, QUEUE_TTL_MS);
        break;
      }

      case "typing": {
        if (!userId) return;
        forward(msg.to, { type: "typing", from: userId, isTyping: msg.isTyping }, 0);
        break;
      }

      case "check_online": {
        if (!userId) return;
        const isOnline = clients.has(msg.userId) && clients.get(msg.userId).ws.readyState === 1;
        send({ type: "online_status", userId: msg.userId, isOnline });
        break;
      }

      case "get_public_key": {
        if (!userId) { send({ type: "error", code: "NOT_REGISTERED" }); return; }
        const target = clients.get(msg.targetUserId);
        if (target) send({ type: "public_key", userId: msg.targetUserId, publicKey: target.publicKey });
        else send({ type: "error", code: "USER_NOT_FOUND", userId: msg.targetUserId });
        break;
      }

      default:
        send({ type: "error", code: "UNKNOWN_TYPE", receivedType: msg.type });
    }
  });

  ws.on("close", () => {
    clearTimeout(heartbeatTimer);
    if (userId && clients.has(userId) && clients.get(userId).ws === ws) {
      clients.delete(userId);
      console.log(`[disconnect] ${userId} (${clients.size} online)`);
    }
  });

  ws.on("error", (err) => console.error(`[ws error] ${userId}: ${err.message}`));
});

function queueOfflineMessage(userId, envelope, ttl) {
  if (!offlineQueue.has(userId)) offlineQueue.set(userId, []);
  const queue = offlineQueue.get(userId);
  if (queue.length >= MAX_QUEUE_PER_USER) queue.shift();
  queue.push({ ...envelope, _queuedAt: Date.now(), _ttl: ttl || QUEUE_TTL_MS });
}

function flushOfflineQueue(userId) {
  if (!offlineQueue.has(userId)) return;
  const queue = offlineQueue.get(userId);
  const client = clients.get(userId);
  const now = Date.now();
  let delivered = 0;
  for (const msg of queue) {
    if (now - msg._queuedAt > msg._ttl) continue;
    if (client && client.ws.readyState === 1) {
      const { _queuedAt, _ttl, ...envelope } = msg;
      client.ws.send(JSON.stringify({ ...envelope, wasQueued: true }));
      delivered++;
    }
  }
  offlineQueue.delete(userId);
  if (delivered > 0) console.log(`[queue] Flushed ${delivered} messages to ${userId}`);
}

setInterval(() => {
  const now = Date.now();
  for (const [uid, queue] of offlineQueue.entries()) {
    const fresh = queue.filter(m => now - m._queuedAt < m._ttl);
    fresh.length === 0 ? offlineQueue.delete(uid) : offlineQueue.set(uid, fresh);
  }
}, 60 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`CipherChat signaling server → ws://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
