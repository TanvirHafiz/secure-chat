/**
 * relay.js — Minimal WebRTC signaling relay.
 *
 * Purpose: Route SDP offers/answers and ICE candidates so WebRTC peers
 *          can establish a direct DataChannel connection.
 *
 * Security properties:
 *   - Never logs room codes, public keys, or any content
 *   - Only stores transient session state (dropped on disconnect)
 *   - Max 2 peers per room (strictly P2P)
 *   - Rate limiting prevents room enumeration/DoS
 *   - Message size capped at 64KB
 *   - After DataChannel opens, client should close this WebSocket
 *
 * Run:  node relay.js [PORT]
 * Default port: 8080
 */

const http      = require('http');
const WebSocket = require('ws');

const PORT          = parseInt(process.env.PORT) || parseInt(process.argv[2]) || 8080;
const MAX_MSG_BYTES = 64 * 1024;          // 64 KB max message size
const MAX_ROOMS     = 1000;               // max concurrent signaling sessions
const ROOM_TTL_MS   = 5 * 60 * 1000;     // rooms expire after 5 minutes
const RATE_LIMIT_MS = 10 * 1000;         // 1 join per IP per 10 seconds
const IDLE_TIMEOUT  = 30 * 1000;         // disconnect idle clients after 30s

// rooms: Map<roomCode, { peers: Set<WebSocket>, timer: NodeJS.Timeout }>
const rooms = new Map();

// rateLimiter: Map<ip, lastJoinTimestamp>
const rateLimiter = new Map();

// HTTP server — required by Render for health checks
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('SecureChat relay OK\n');
});

const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log(`[relay] Signaling relay listening on ws://0.0.0.0:${PORT}`);
  console.log('[relay] Routes SDP/ICE only. No message content ever handled.');
});

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  ws._room    = null;
  ws._alive   = true;

  // Idle timeout: disconnect if no ping received
  ws._idleTimer = setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) ws.terminate();
  }, IDLE_TIMEOUT);

  ws.on('pong', () => {
    ws._alive = true;
  });

  ws.on('message', (raw) => {
    // Enforce message size limit
    if (raw.length > MAX_MSG_BYTES) {
      sendError(ws, 'Message too large');
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      sendError(ws, 'Invalid JSON');
      return;
    }

    if (!msg.type) {
      sendError(ws, 'Missing type');
      return;
    }

    switch (msg.type) {
      case 'join':    handleJoin(ws, msg, ip);    break;
      case 'offer':   handleRelay(ws, 'offer',   { sdp: msg.sdp });       break;
      case 'answer':  handleRelay(ws, 'answer',  { sdp: msg.sdp });       break;
      case 'ice':     handleRelay(ws, 'ice',     { candidate: msg.candidate }); break;
      case 'ping':    ws.send(JSON.stringify({ type: 'pong' }));           break;
      case 'leave':   handleLeave(ws);                                      break;
      default:        sendError(ws, 'Unknown message type');
    }
  });

  ws.on('close', () => {
    clearTimeout(ws._idleTimer);
    handleLeave(ws);
  });

  ws.on('error', () => {
    clearTimeout(ws._idleTimer);
    handleLeave(ws);
  });
});

// Heartbeat: ping all clients every 15s to detect dead connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws._alive) { ws.terminate(); return; }
    ws._alive = false;
    ws.ping();
  });
}, 15000);

wss.on('close', () => clearInterval(heartbeat));

// ── Handlers ────────────────────────────────────────────────────────────────

function handleJoin(ws, msg, ip) {
  const room = msg.room;
  const pubKey = msg.pubKey;

  // Validate inputs
  if (typeof room !== 'string' || room.length < 3 || room.length > 32) {
    sendError(ws, 'Invalid room code');
    return;
  }
  if (typeof pubKey !== 'string' || pubKey.length > 512) {
    sendError(ws, 'Invalid pubKey');
    return;
  }

  // Rate limiting per IP
  const now = Date.now();
  const lastJoin = rateLimiter.get(ip) || 0;
  if (now - lastJoin < RATE_LIMIT_MS) {
    sendError(ws, 'Rate limited — wait before joining again');
    return;
  }
  rateLimiter.set(ip, now);

  // Leave any existing room
  if (ws._room) handleLeave(ws);

  // Room capacity check
  if (rooms.size >= MAX_ROOMS && !rooms.has(room)) {
    sendError(ws, 'Server at capacity');
    return;
  }

  // Get or create room
  if (!rooms.has(room)) {
    const timer = setTimeout(() => expireRoom(room), ROOM_TTL_MS);
    rooms.set(room, { peers: new Set(), timer });
  }

  const roomData = rooms.get(room);

  if (roomData.peers.size >= 2) {
    sendError(ws, 'Room is full');
    return;
  }

  roomData.peers.add(ws);
  ws._room   = room;
  ws._pubKey = pubKey;

  // If two peers are now in the room, notify each of the other's pubKey
  if (roomData.peers.size === 2) {
    const [peerA, peerB] = [...roomData.peers];
    send(peerA, { type: 'peer_joined', pubKey: peerB._pubKey });
    send(peerB, { type: 'peer_joined', pubKey: peerA._pubKey });
  } else {
    // First peer — acknowledge join, waiting for second peer
    send(ws, { type: 'waiting' });
  }
}

function handleRelay(ws, type, payload) {
  if (!ws._room) { sendError(ws, 'Not in a room'); return; }
  const roomData = rooms.get(ws._room);
  if (!roomData) return;

  // Relay to the OTHER peer in the room only
  roomData.peers.forEach((peer) => {
    if (peer !== ws && peer.readyState === WebSocket.OPEN) {
      send(peer, { type, ...payload });
    }
  });
}

function handleLeave(ws) {
  if (!ws._room) return;
  const room = ws._room;
  ws._room = null;

  const roomData = rooms.get(room);
  if (!roomData) return;

  roomData.peers.delete(ws);

  // Notify remaining peer
  roomData.peers.forEach((peer) => {
    if (peer.readyState === WebSocket.OPEN) {
      send(peer, { type: 'peer_left' });
    }
  });

  // Clean up empty room
  if (roomData.peers.size === 0) {
    clearTimeout(roomData.timer);
    rooms.delete(room);
  }
}

function expireRoom(room) {
  const roomData = rooms.get(room);
  if (!roomData) return;
  roomData.peers.forEach((peer) => {
    if (peer.readyState === WebSocket.OPEN) {
      send(peer, { type: 'peer_left' });
      peer.terminate();
    }
  });
  rooms.delete(room);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function sendError(ws, message) {
  send(ws, { type: 'error', message });
}

// Clean up stale rate limiter entries every minute
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_MS;
  rateLimiter.forEach((ts, ip) => {
    if (ts < cutoff) rateLimiter.delete(ip);
  });
}, 60000);
