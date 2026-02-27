# SecureChat

A browser-based, end-to-end encrypted P2P chat application. Messages are encrypted **inside your browser** before being sent — no server ever sees your plaintext. Built for use when internet infrastructure is restricted or unavailable.

---

## How It Works

SecureChat works like a modern Enigma machine:

1. Both users generate a **one-time session code** (e.g. `TIGER-4829`) and share it verbally or in person
2. Each browser generates an **ephemeral ECDH keypair** — private keys never leave the device
3. Public keys are exchanged via signaling (relay server or copy-paste)
4. A **shared AES-256 encryption key** is derived using ECDH + HKDF, mixed with the session code
5. All messages are encrypted with **AES-256-GCM** before transmission
6. The relay server (if used) only routes WebRTC handshake data — never message content

```
Alice's browser                              Bob's browser
──────────────                               ─────────────
Plaintext → [AES-256-GCM encrypt] → ciphertext → [AES-256-GCM decrypt] → Plaintext
                    ↑                                         ↑
          HKDF(ECDH secret, session code)          HKDF(ECDH secret, session code)
```

**If a man-in-the-middle substitutes public keys**, they derive a different encryption key — their injected messages will fail to decrypt on the other side. The session code binding in HKDF makes MITM detectable.

---

## Features

| Feature | Details |
|---------|---------|
| Encryption | AES-256-GCM per message |
| Key exchange | ECDH P-256 (ephemeral per session) |
| Key derivation | HKDF-SHA-256 with session code as salt |
| Replay protection | Sequence numbers in GCM AAD |
| Transports | WebRTC DataChannel, Web Bluetooth |
| Signaling | WebSocket relay or manual copy-paste |
| Dependencies | **Zero** — uses only browser Web Crypto API |
| Server storage | None — relay never stores keys or messages |
| Persistence | None — keys deleted on session end |

---

## Connection Modes

### 1. Relay Mode (LAN or Internet)
Uses a minimal WebSocket relay server for WebRTC signaling (exchanging SDP and ICE). Once the WebRTC DataChannel is established, the relay connection is dropped and all communication is direct P2P.

### 2. Manual Mode (Fully Offline)
Copy and paste the SDP offer/answer between devices using any channel (USB, QR code, another app). No server required at all.

### 3. Bluetooth Mode (No Internet)
Uses the Web Bluetooth API to communicate directly between two nearby devices over GATT. Works completely offline. Requires Chrome/Edge on Android or desktop.

---

## Quick Start (Local Testing)

### Requirements
- Node.js 18+ (for the relay server)
- A modern browser (Chrome, Edge, or Firefox)
- Two browser tabs, or two devices on the same network

### 1. Clone the repository

```bash
git clone https://github.com/TanvirHafiz/secure-chat.git
cd secure-chat
```

### 2. Start the relay server

```bash
cd server
npm install
node relay.js
```

You should see:
```
[relay] Signaling relay listening on ws://0.0.0.0:8080
```

### 3. Serve the frontend

Open a second terminal in the project root:

```bash
npx serve .
```

Or use any static file server. The app **cannot** be opened directly as `file://` — it must be served over HTTP/HTTPS.

### 4. Open two browser tabs

Go to `http://localhost:3000` (or whatever port `serve` reports) in **two tabs**.

In the relay URL input at the top, change it to:
```
ws://localhost:8080
```

### 5. Start a chat

**Tab A (Host):**
1. Click **Start New Session**
2. Note the session code (e.g. `FALCON-0312`)
3. Click **Connect →**

**Tab B (Joiner):**
1. Click **Join Existing Session**
2. Enter the same session code: `FALCON-0312`

Both tabs will connect, exchange keys, verify the channel, and enter the chat screen.

---

## Deployment (Production)

### Deploy the Relay Server — Render.com (Free)

1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect your GitHub repo
3. Configure:
   - **Root directory:** `server`
   - **Build command:** `npm install`
   - **Start command:** `node relay.js`
   - **Environment:** Node
4. Click **Deploy**
5. Your relay URL will be something like `wss://your-app.onrender.com`

To verify it's running, open `https://your-app.onrender.com` in a browser — you should see:
```
SecureChat relay OK
```

> **Note:** Render's free tier puts services to sleep after 15 minutes of inactivity. The first connection after idle may take 20–40 seconds while the server wakes up.

---

### Deploy the Frontend — Netlify (Free)

**Option A — Drag and Drop (no account linking needed):**
1. Go to [netlify.com](https://netlify.com) and log in
2. Scroll to the bottom of the dashboard — find the drag-and-drop zone
3. Drag your entire `secure-chat` project folder onto it
4. Netlify deploys instantly and gives you a live URL

**Option B — Connect GitHub:**
1. New site → Import from Git → GitHub → select `secure-chat`
2. Build command: *(leave blank)*
3. Publish directory: `.`
4. Deploy

---

### Update the Relay URL

After deploying the relay, update the default URL in two files:

**`index.html`** — line 27:
```html
value="wss://your-relay.onrender.com"
```

**`js/app.js`** — line 20:
```js
const DEFAULT_RELAY = 'wss://your-relay.onrender.com';
```

Replace `your-relay.onrender.com` with your actual Render URL, then push to GitHub. Netlify will auto-redeploy.

---

## Security Model

### What is protected
- Message content — encrypted with AES-256-GCM before leaving the browser
- Private keys — generated in-browser, never exported, destroyed on session end
- Session codes — shared verbally out-of-band, never sent over the relay
- Key authenticity — session code is mixed into HKDF salt; MITM gets a different key

### What is NOT protected
- **Metadata** — the relay server sees IP addresses and session code hashes (room identifiers)
- **Traffic analysis** — an observer can see that two IPs are communicating and the size/timing of messages
- **Device compromise** — if your browser or OS is compromised, plaintext is readable in memory
- **Session code interception** — if someone intercepts the verbal session code, they could attempt a MITM

### Cryptographic primitives

| Operation | Algorithm | Notes |
|-----------|-----------|-------|
| Key exchange | ECDH P-256 | Ephemeral per session |
| Key derivation | HKDF-SHA-256 | Salt = SHA-256("secure-chat-v1\|" + sessionCode) |
| Message encryption | AES-256-GCM | Non-extractable CryptoKey |
| IV generation | `crypto.getRandomValues(12)` | Per message |
| Replay protection | 8-byte sequence number | Included in GCM AAD |
| Fingerprint | SHA-256 of public key | Optional manual verification |

All cryptography uses the browser's built-in **Web Crypto API** — no external libraries.

---

## File Structure

```
secure-chat/
├── index.html              # Single-page app — all screens as hidden divs
├── css/
│   └── app.css             # Dark terminal UI, responsive
├── js/
│   ├── crypto.js           # ECDH, HKDF, AES-GCM via Web Crypto API
│   ├── session.js          # Session codes, key exchange, encrypt/decrypt
│   ├── signaling.js        # WebSocket relay client
│   ├── webrtc.js           # WebRTC DataChannel transport
│   ├── bluetooth.js        # Web Bluetooth GATT transport
│   ├── transport.js        # Unified transport abstraction layer
│   ├── ui.js               # DOM helpers (XSS-safe, textContent only)
│   └── app.js              # State machine, event wiring
└── server/
    ├── relay.js            # Node.js WebSocket signaling relay (~230 lines)
    └── package.json        # Single dependency: ws@^8
```

No build tools, no bundler, no framework. Scripts are loaded as plain `<script>` tags.

---

## Session Code Format

```
Format: WORD-NNNN
Example: TIGER-4829, FALCON-0312, MOUNTAIN-5571

  WORD : 1 of 256 carefully chosen words (phonetically unambiguous)
  NNNN : 4 decimal digits (0000–9999)
Entropy : ~21 bits
```

The session code is **not a password** — it's a MITM detection mechanism. It is shared verbally or in person so that both parties can confirm they are talking to each other. An attacker who intercepts only the digital channel cannot know the session code, and substituting public keys will produce a different encryption key that fails verification.

---

## Message Wire Format

Each encrypted message is a binary envelope:

```
[ 8 bytes ] Sequence number (big-endian uint64) — included in GCM AAD
[12 bytes ] IV (random per message)
[ 2 bytes ] Ciphertext length
[ N bytes ] Ciphertext + 16-byte GCM authentication tag
```

The sequence number in the AAD means that replaying a captured packet will fail GCM authentication — even if the ciphertext is unchanged, the wrong sequence number causes the tag to not match.

---

## Relay Server Details

The relay (`server/relay.js`) is intentionally minimal:

- Routes: `join → waiting/peer_joined`, `offer → offer`, `answer → answer`, `ice → ice`
- Max **2 peers per room** — strictly P2P
- **Rate limiting**: 1 join per IP per 10 seconds
- **Message size cap**: 64 KB
- **Room TTL**: 5 minutes (rooms auto-expire)
- **Idle timeout**: 30 seconds (inactive connections dropped)
- **Never logs** session codes, public keys, or message content
- Closes relay WebSocket as soon as the WebRTC DataChannel opens

To run on your LAN without internet:
```bash
node server/relay.js
# then in the app, set relay URL to ws://192.168.1.x:8080
```

---

## Troubleshooting

### "Connection timeout" on relay mode
- Visit `https://your-relay.onrender.com` first to wake the server (Render free tier sleeps)
- Check Render dashboard → Logs for errors
- Make sure the relay URL starts with `wss://` (not `ws://`) for HTTPS-hosted frontends

### "DataChannel not open" error
- This was a known bug (now fixed) — ensure you have the latest code
- The app now waits for the WebRTC DataChannel to fully open before sending the key verification ping

### Bluetooth not working
- Requires Chrome or Edge (Firefox does not support Web Bluetooth)
- On desktop Windows/Mac, Bluetooth must be enabled in system settings
- The host (advertising) side has limited browser support — use relay mode for initial discovery if Bluetooth hosting fails

### Two tabs on same machine won't connect via WebRTC
- This is normal on some networks — WebRTC loopback can be blocked
- Use two different devices on the same WiFi network instead
- Or use Manual mode (copy-paste SDP) which always works

### STUN/ICE — connecting across the internet
By default, `webrtc.js` uses `DEFAULT_ICE = []` (no STUN servers), which works on LAN. For internet connections, add a STUN server in `js/webrtc.js`:

```js
const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
```

---

## Browser Support

| Browser | WebRTC | Web Bluetooth |
|---------|--------|---------------|
| Chrome 90+ | ✅ | ✅ |
| Edge 90+ | ✅ | ✅ |
| Firefox 90+ | ✅ | ❌ |
| Safari 15+ | ✅ | ❌ |
| Chrome Android | ✅ | ✅ |

Manual mode (copy-paste SDP) works in all browsers that support WebRTC.

---

## License

MIT — do whatever you want with it. Built for people who need it.
