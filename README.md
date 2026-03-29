<div align="center">

```
 ██████╗██╗██████╗ ██╗  ██╗███████╗██████╗      ███████╗███████╗██████╗ ██╗   ██╗███████╗██████╗ 
██╔════╝██║██╔══██╗██║  ██║██╔════╝██╔══██╗     ██╔════╝██╔════╝██╔══██╗██║   ██║██╔════╝██╔══██╗
██║     ██║██████╔╝███████║█████╗  ██████╔╝     ███████╗█████╗  ██████╔╝██║   ██║█████╗  ██████╔╝
██║     ██║██╔═══╝ ██╔══██║██╔══╝  ██╔══██╗     ╚════██║██╔══╝  ██╔══██╗╚██╗ ██╔╝██╔══╝  ██╔══██╗
╚██████╗██║██║     ██║  ██║███████╗██║  ██║     ███████║███████╗██║  ██║ ╚████╔╝ ███████╗██║  ██║
 ╚═════╝╚═╝╚═╝     ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝     ╚══════╝╚══════╝╚═╝  ╚═╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝
```

**The signaling server — routes ciphertext only. Stores nothing. Sees nothing.**

[![Node.js](https://img.shields.io/badge/Node.js-20-339933?style=flat-square&logo=nodedotjs)](https://nodejs.org)
[![WebSocket](https://img.shields.io/badge/WebSocket-RFC%206455-blue?style=flat-square)](https://datatracker.ietf.org/doc/html/rfc6455)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker)](https://docker.com)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

> **Mobile app repo:** [cipher-chat-app](https://github.com/vishalkirtaniya/cipher-chat-app)

</div>

---

## What This Server Does (and Does Not Do)

This is the signaling server for CipherChat. Its job is deliberately minimal:

| ✅ Does | ❌ Never does |
|---|---|
| Accept WebSocket connections | Store messages to disk |
| Register `userId → socket` in memory | Read or decrypt message content |
| Route encrypted envelopes between peers | Store private keys or shared secrets |
| Queue messages for offline users (in-memory, TTL-based) | Write to any database |
| Forward delivery receipts and delete signals | Log message content |
| Handle typing indicators | Retain user data after disconnect |

The server sees: `{ from, to, messageId, ciphertext, nonce, senderPublicKey }`

The server **never** sees the plaintext. Even if this server is completely compromised, an attacker gets only opaque base64 blobs they cannot decrypt without the recipient's private key — which never leaves the recipient's device.

---

## Table of Contents

- [Architecture](#architecture)
- [How It Works](#how-it-works)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
  - [Run Locally](#run-locally)
  - [Run with Docker](#run-with-docker)
  - [Deploy to EC2](#deploy-to-ec2)
- [WebSocket Protocol](#websocket-protocol)
- [Configuration](#configuration)
- [Future Roadmap](#future-roadmap)
- [Security Notes](#security-notes)

---

## Architecture

```
                         Internet
                            │
                    ┌───────▼────────┐
                    │   EC2 Instance │
                    │                │
                    │  ┌──────────┐  │
                    │  │  Docker  │  │
                    │  │          │  │
                    │  │  Node.js │  │
                    │  │  :8080   │  │
                    │  │          │  │
                    │  │ HTTP     │  │   GET /health → {"status":"ok"}
                    │  │ WS       │  │
                    │  └────┬─────┘  │
                    │       │        │
                    └───────┼────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
        WS conn        WS conn       WS conn
              │             │             │
         ┌────▼────┐   ┌────▼────┐   ┌───▼─────┐
         │ Phone A │   │ Phone B │   │ Phone C │
         └─────────┘   └─────────┘   └─────────┘

In-memory state (never on disk):
  clients:      Map<userId, { ws, publicKey, lastSeen }>
  offlineQueue: Map<userId, [encryptedEnvelope]>
```

---

## How It Works

### Connection Lifecycle

```
1. Client opens WebSocket connection
2. Client sends: { type: "register", userId: "u_abc", publicKey: "base64..." }
3. Server registers userId → socket in the clients Map
4. Server flushes any queued offline messages for this userId
5. Server sends: { type: "registered", userId, serverTime }
6. Client sends ping every 25s; server responds pong; resets 35s timeout
7. On disconnect: userId removed from clients Map
```

### Message Routing

```
Alice sends: {
  type: "message",
  to: "u_bob",
  from: "u_alice",
  messageId: "abc123",
  payload: { ciphertext: "...", nonce: "...", senderPublicKey: "..." },
  timestamp: 1234567890,
  ttl: 300000
}

Server:
  1. Sends ack { status: "server_received" } to Alice
  2. Checks if Bob is in clients Map and socket is OPEN
  3a. Bob online  → forwards envelope to Bob's socket
                   → sends ack { status: "delivered" } to Alice
  3b. Bob offline → pushes to offlineQueue[Bob]
                   → sends ack { status: "queued" } to Alice
  4. When Bob reconnects → flushes queue → all envelopes delivered with wasQueued: true
```

### Heartbeat

Clients must send `{ type: "ping" }` every 25 seconds. The server resets a 35-second timeout on each ping. If 35 seconds pass without a ping, the server calls `ws.terminate()` and removes the client from the registry.

---

## Tech Stack

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 20 | Runtime — ES modules |
| `ws` | 8.x | WebSocket server library |
| Docker | 29+ | Containerization |
| docker-compose | v2 | Container orchestration |
| Ubuntu | 24.04 | EC2 AMI |

**Dependencies: just 1.** The entire server runs on `ws` — no Express, no database ORM, no Redis, no authentication middleware. The simplicity is intentional: fewer dependencies = smaller attack surface.

---

## Project Structure

```
cipher-chat-server/
├── index.js              # The entire server — ~200 lines of clean Node.js
│                         #   WebSocket handler, message router, offline queue
├── package.json          # One runtime dependency: ws
├── Dockerfile            # Multi-stage build: deps → runner (non-root user)
├── docker-compose.yml    # Container config with health check + resource limits
└── .dockerignore         # Excludes node_modules, logs, test files
```

---

## Getting Started

### Run Locally

```bash
# Clone the repo
git clone https://github.com/yourusername/cipher-chat-server.git
cd cipher-chat-server

# Install (just one package)
npm install

# Start
npm start
```

Output:
```
CipherChat signaling server → ws://localhost:8080
Health: http://localhost:8080/health
```

Verify:
```bash
curl http://localhost:8080/health
# {"status":"ok","connectedClients":0,"uptime":3.2}
```

**Dev mode with auto-reload:**
```bash
npm run dev   # uses nodemon
```

**Integration tests** (run while server is running in another terminal):
```bash
node test-server.js
```

Expected output:
```
CipherChat Server Tests

1. Registration
  ✓ Alice connected and registered
  ✓ Bob connected and registered

2. Message delivery (both online)
  ✓ Alice received delivered ack
  ✓ Bob received message from Alice
  ✓ Payload unchanged (server did not modify ciphertext)

3. Public key exchange
  ✓ Alice retrieved Bob's public key

4. Read receipts
  ✓ Alice received read receipt from Bob

5. Offline message queuing
  ✓ Message queued when recipient offline
  ✓ Queued message flushed on reconnect
  ✓ Flushed payload is unchanged

6. Typing indicator
  ✓ Typing indicator forwarded to Bob

7. Delete message signal
  ✓ Delete signal forwarded to Bob

8. Heartbeat
  ✓ Pong received with serverTime

────────────────────────────────────────
Results: 8 passed, 0 failed
```

---

### Run with Docker

```bash
# Build image
docker compose build

# Start container
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

Health check is built into the container — Docker will automatically restart it if it becomes unhealthy.

---

### Deploy to EC2

#### Prerequisites
- EC2 instance running Ubuntu 22.04 or 24.04
- Port **8080** open in the Security Group (Custom TCP, Source: 0.0.0.0/0)
- Your `.pem` key file

#### One-command deploy

Edit the config block at the top of `deploy.sh`:

```bash
EC2_USER="ubuntu"
EC2_HOST="YOUR_EC2_IP"
PEM_FILE="/path/to/your-key.pem"
REMOTE_DIR="~/cipher-chat-server"
```

Then:

```bash
chmod +x deploy.sh
./deploy.sh
```

The script:
1. Rsyncs all server files to EC2 (excludes `node_modules`, logs, test files)
2. Installs Docker on EC2 if not already present
3. Builds the Docker image on EC2
4. Starts the container with `docker compose up -d`
5. Hits `/health` to confirm the server is live

**Expected output:**
```
▶ Syncing server files to EC2...
✓ Files synced
▶ Checking Docker on EC2...
✓ Docker ready
▶ Building and starting CipherChat server...
✓ Server started
▶ Checking server health...
✓ Server is healthy!

  WebSocket:   ws://YOUR_EC2_IP:8080
  Health:      http://YOUR_EC2_IP:8080/health

Update your .env:
  EXPO_PUBLIC_SERVER_URL=ws://YOUR_EC2_IP:8080

✓ Deploy complete 🚀
```

#### Useful EC2 commands

```bash
# SSH in
ssh -i your-key.pem ubuntu@YOUR_EC2_IP

# Live logs
cd ~/cipher-chat-server && docker compose logs -f

# Restart
docker compose restart

# Status
docker compose ps

# Stop
docker compose down

# Health check
curl http://localhost:8080/health
```

---

## WebSocket Protocol

All messages are JSON. The server routes by `userId`. Message content is always an opaque encrypted blob — the server never inspects `payload`.

### Client → Server

```json
// On connect — register your userId and public key
{ "type": "register", "userId": "u_abc123", "publicKey": "base64_public_key" }

// Heartbeat — send every 25s or server terminates the connection after 35s
{ "type": "ping" }

// Send an encrypted message
{
  "type": "message",
  "to": "u_xyz456",
  "from": "u_abc123",
  "messageId": "unique_id",
  "payload": {
    "ciphertext": "base64_encrypted_content",
    "nonce": "base64_24_byte_nonce",
    "senderPublicKey": "base64_public_key"
  },
  "timestamp": 1234567890123,
  "ttl": 300000
}

// Read/delivered receipt
{ "type": "receipt", "to": "u_xyz456", "messageIds": ["id1", "id2"], "status": "read" }

// Signal peer to delete messages
{ "type": "delete_message", "to": "u_xyz456", "messageIds": ["id1"] }

// Typing indicator
{ "type": "typing", "to": "u_xyz456", "isTyping": true }

// Check if a user is online
{ "type": "check_online", "userId": "u_xyz456" }

// Get a user's public key (from in-memory registry)
{ "type": "get_public_key", "targetUserId": "u_xyz456" }
```

### Server → Client

```json
// Registration confirmed
{ "type": "registered", "userId": "u_abc123", "serverTime": 1234567890123 }

// Heartbeat response
{ "type": "pong", "serverTime": 1234567890123 }

// Message delivery status
{ "type": "ack", "messageId": "unique_id", "status": "server_received|delivered|queued", "serverTime": 1234567890123 }

// Incoming message (forwarded from sender)
{
  "type": "message",
  "from": "u_xyz456",
  "messageId": "unique_id",
  "payload": { "ciphertext": "...", "nonce": "...", "senderPublicKey": "..." },
  "timestamp": 1234567890123,
  "wasQueued": true
}

// Incoming receipt
{ "type": "receipt", "from": "u_xyz456", "messageIds": ["id1"], "status": "read", "timestamp": 1234567890123 }

// Incoming delete signal
{ "type": "delete_message", "from": "u_xyz456", "messageIds": ["id1"], "timestamp": 1234567890123 }

// Incoming typing indicator
{ "type": "typing", "from": "u_xyz456", "isTyping": true }

// Online status response
{ "type": "online_status", "userId": "u_xyz456", "isOnline": true }

// Public key response
{ "type": "public_key", "userId": "u_xyz456", "publicKey": "base64_public_key" }

// Error
{ "type": "error", "code": "NOT_REGISTERED|MISSING_FIELDS|USER_NOT_FOUND|UNKNOWN_TYPE", "detail": "..." }
```

---

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket port |
| `NODE_ENV` | `production` | Node environment |

Set via `docker-compose.yml` or shell environment:

```bash
PORT=9000 npm start
```

**Offline queue limits** (hardcoded in `index.js`, change as needed):

| Constant | Default | Description |
|---|---|---|
| `QUEUE_TTL_MS` | 7 days | How long to hold messages for offline users |
| `MAX_QUEUE_PER_USER` | 500 | Max queued messages per user before dropping oldest |

---

## Future Roadmap

### 🔐 Security
- **Sealed sender** — Encrypt the `from` field so the server cannot see who is messaging whom, only who the recipient is.
- **Rate limiting** — Per-userId message rate limiting to prevent abuse.
- **TLS termination** — Nginx reverse proxy with Let's Encrypt for `wss://` in production.
- **Connection authentication** — Optional JWT/token-based connection auth so only registered users can connect.

### 📞 Voice & Video (WebRTC Signaling)
- **Call signaling** — Handle WebRTC `offer`, `answer`, and `ICE candidate` messages for peer-to-peer voice and video calls. The server only brokers the connection — the media stream goes directly between devices, never through the server.
- **TURN server integration** — For users behind strict NAT/firewalls where direct P2P fails.

### 🏗 Infrastructure
- **Redis offline queue** — Replace the in-memory offline queue with Redis (TTL-based keys) so queued messages survive server restarts. Messages remain encrypted blobs — Redis just stores them.
- **Horizontal scaling** — Redis pub/sub for WebSocket message routing across multiple server instances behind a load balancer.
- **Prometheus metrics** — Expose `/metrics` for connected clients, messages routed, queue depth, and error rates.
- **Structured logging** — JSON logs with request IDs for easier debugging in production.

---

## Security Notes

1. **No TLS in this setup** — The Docker container runs plain `ws://`. For production, put Nginx in front with a Let's Encrypt certificate to get `wss://`.

2. **In-memory only** — The server holds no state on disk. A restart clears all connections and offline queues. This is a feature (no data at rest) and a limitation (queued messages lost on restart).

3. **No authentication** — Any client that knows the server URL can connect and register any `userId`. For production, add token-based auth on the `register` message.

4. **Social graph** — The server knows which userIds communicate with each other (from/to pairs), even though it cannot read message content. Sealed sender (roadmap) addresses this.

5. **Resource limits** — The Docker container is capped at 0.5 CPU and 256MB RAM. Adjust in `docker-compose.yml` based on your expected load.

---

## Contributing

Pull requests welcome. Please open an issue first for major changes.

```bash
# Run integration tests (server must be running)
node test-server.js
```

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

<div align="center">

Built with 🔒 by Vishal · A server that knows as little as possible, by design.

</div>