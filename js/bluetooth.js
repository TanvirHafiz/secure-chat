/**
 * bluetooth.js — Web Bluetooth GATT transport.
 *
 * Custom GATT service for secure P2P chat.
 * One device hosts (advertises), the other joins (scans and connects).
 *
 * Service UUID:    a7f3b200-1234-4abc-8def-0123456789ab
 * Characteristics:
 *   Handshake  a7f3b201  WRITE | READ | NOTIFY  — ECDH pubKey exchange
 *   TX         a7f3b202  WRITE_WITHOUT_RESPONSE  — Send message chunks to peer
 *   RX         a7f3b203  NOTIFY                  — Receive message chunks from peer
 *   Control    a7f3b204  WRITE | NOTIFY          — READY / END_SESSION signals
 *
 * Large messages are fragmented into 508-byte chunks with a 4-byte header:
 *   [flags: 1][chunkIndex: 1][totalChunks: 2 big-endian]
 *   flags: 0x01=FIRST, 0x02=MIDDLE, 0x04=LAST, 0x08=ONLY
 *
 * NOTE: Web Bluetooth requires a HTTPS page or localhost.
 *       Not all browsers support Web Bluetooth (Chrome/Edge desktop/Android).
 */

const SecureChatBluetooth = (() => {

  const SERVICE_UUID    = 'a7f3b200-1234-4abc-8def-0123456789ab';
  const HANDSHAKE_UUID  = 'a7f3b201-1234-4abc-8def-0123456789ab';
  const TX_UUID         = 'a7f3b202-1234-4abc-8def-0123456789ab';
  const RX_UUID         = 'a7f3b203-1234-4abc-8def-0123456789ab';
  const CONTROL_UUID    = 'a7f3b204-1234-4abc-8def-0123456789ab';

  const CHUNK_PAYLOAD   = 508;
  const FLAG_FIRST      = 0x01;
  const FLAG_MIDDLE     = 0x02;
  const FLAG_LAST       = 0x04;
  const FLAG_ONLY       = 0x08;

  const CTRL_READY      = new Uint8Array([0x01]);
  const CTRL_END        = new Uint8Array([0x02]);

  /**
   * Check if Web Bluetooth is available in this browser.
   */
  function isAvailable() {
    return !!(navigator.bluetooth);
  }

  class BluetoothTransport {
    constructor() {
      this._device      = null;
      this._server      = null;
      this._service     = null;
      this._chars       = {};
      this._rxBuffer    = new Map(); // msgId -> chunks array
      this._onMessage   = null;
      this._onDisconnect = null;
      this._onStatus    = null;
      this.type = 'bluetooth';
    }

    get isConnected() {
      return this._device && this._device.gatt.connected;
    }

    // ── Join session (Central role) ───────────────────────────────────────

    /**
     * Scan for and connect to a Bluetooth host.
     * @param {string} sessionCode - Verbally agreed session code
     * @param {string} ownPubKeyB64 - Own ECDH public key in base64
     * @returns {Promise<{ peerPubKeyB64: string }>}
     */
    async joinSession(sessionCode, ownPubKeyB64) {
      if (!isAvailable()) throw new Error('Web Bluetooth not available in this browser');

      this._statusUpdate('Requesting Bluetooth device…');

      // Browser shows a picker — user selects the host device
      this._device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID],
      });

      this._device.addEventListener('gattserverdisconnected', () => {
        this._handleDisconnect('Bluetooth connection lost');
      });

      this._statusUpdate('Connecting to device…');
      this._server  = await this._device.gatt.connect();
      this._service = await this._server.getPrimaryService(SERVICE_UUID);

      // Get all characteristics
      this._chars.handshake = await this._service.getCharacteristic(HANDSHAKE_UUID);
      this._chars.tx        = await this._service.getCharacteristic(TX_UUID);
      this._chars.rx        = await this._service.getCharacteristic(RX_UUID);
      this._chars.control   = await this._service.getCharacteristic(CONTROL_UUID);

      // Subscribe to RX notifications (incoming messages from host)
      await this._chars.rx.startNotifications();
      this._chars.rx.addEventListener('characteristicvaluechanged', (e) => {
        this._onChunk(new Uint8Array(e.target.value.buffer));
      });

      // Subscribe to control notifications
      await this._chars.control.startNotifications();

      // Exchange public keys: write ours to handshake, read theirs
      const ownPubKey = SecureChatCrypto.base64ToArrayBuffer(ownPubKeyB64);
      await this._chars.handshake.writeValue(ownPubKey);

      this._statusUpdate('Exchanging keys…');
      const peerPubKeyBuffer = await this._chars.handshake.readValue();
      const peerPubKeyB64    = SecureChatCrypto.arrayBufferToBase64(peerPubKeyBuffer.buffer);

      // Signal READY
      await this._chars.control.writeValue(CTRL_READY);

      return { peerPubKeyB64 };
    }

    // ── Host session (Peripheral role) ────────────────────────────────────
    // NOTE: Full Peripheral/advertising requires native app APIs.
    // In the browser via Web Bluetooth, only Central role is supported.
    // The "host" flow in browser context asks the user to initiate from
    // the other device (which will scan and find this session by code).
    //
    // For true host advertising, this app uses a helper approach:
    // The host generates the session code and displays it; the joiner
    // must initiate the Bluetooth connection request. This is a limitation
    // of current Web Bluetooth spec (no advertising/peripheral API in browsers).

    /**
     * Prepare host-side Bluetooth session.
     * Since browsers can't advertise, the host displays the session code
     * and waits. The joiner will initiate the BT connection.
     *
     * In practice: the host can optionally run a Node.js helper script
     * that advertises the GATT service. Without it, both sides use
     * the Central role and connect via the relay for initial discovery,
     * then switch to Bluetooth for subsequent messages.
     *
     * Returns a status message to display to the user.
     */
    async hostSession(sessionCode, ownPubKeyB64) {
      // Browser limitation: cannot advertise/be Peripheral
      // Return instructions for the user
      return {
        browserLimited: true,
        message: 'Display this session code to your peer. Ask them to click "Connect via Bluetooth" and enter this code.',
        sessionCode,
      };
    }

    // ── Send / Receive ────────────────────────────────────────────────────

    /**
     * Send encrypted binary data to peer (fragmented if > CHUNK_PAYLOAD).
     * @param {Uint8Array} data
     */
    async send(data) {
      if (!this.isConnected) throw new Error('Bluetooth not connected');

      const chunks = this._fragment(data);
      for (const chunk of chunks) {
        await this._chars.tx.writeValueWithoutResponse(chunk);
        // Small yield to prevent BLE congestion
        await new Promise(r => setTimeout(r, 10));
      }
    }

    onMessage(callback)    { this._onMessage    = callback; }
    onDisconnect(callback) { this._onDisconnect = callback; }
    onStatus(callback)     { this._onStatus     = callback; }

    disconnect() {
      if (this._chars.control && this.isConnected) {
        this._chars.control.writeValue(CTRL_END).catch(() => {});
      }
      if (this._server && this.isConnected) {
        this._server.disconnect();
      }
      this._device   = null;
      this._server   = null;
      this._service  = null;
      this._chars    = {};
      this._rxBuffer = new Map();
    }

    // ── Fragmentation ─────────────────────────────────────────────────────

    _fragment(data) {
      const chunks = [];
      const total  = Math.ceil(data.length / CHUNK_PAYLOAD);

      for (let i = 0; i < total; i++) {
        const payload = data.slice(i * CHUNK_PAYLOAD, (i + 1) * CHUNK_PAYLOAD);
        const header  = new Uint8Array(4);

        let flags = FLAG_MIDDLE;
        if (total === 1)       flags = FLAG_ONLY;
        else if (i === 0)      flags = FLAG_FIRST;
        else if (i === total - 1) flags = FLAG_LAST;

        header[0] = flags;
        header[1] = i & 0xFF;
        header[2] = (total >> 8) & 0xFF;
        header[3] = total & 0xFF;

        const chunk = new Uint8Array(header.length + payload.length);
        chunk.set(header, 0);
        chunk.set(payload, 4);
        chunks.push(chunk);
      }

      return chunks;
    }

    _onChunk(chunk) {
      if (chunk.length < 4) return;

      const flags       = chunk[0];
      const chunkIndex  = chunk[1];
      const totalChunks = (chunk[2] << 8) | chunk[3];
      const payload     = chunk.slice(4);

      const msgKey = `${totalChunks}-${chunkIndex === 0 ? Date.now() : this._currentMsgKey}`;

      if (flags === FLAG_ONLY) {
        // Single-chunk message — deliver immediately
        if (this._onMessage) this._onMessage(payload);
        return;
      }

      if (flags === FLAG_FIRST) {
        this._currentMsgKey = Date.now();
        this._rxBuffer.set(this._currentMsgKey, {
          total: totalChunks,
          chunks: new Array(totalChunks),
        });
      }

      const buf = this._rxBuffer.get(this._currentMsgKey);
      if (!buf) return;

      buf.chunks[chunkIndex] = payload;

      if (flags === FLAG_LAST) {
        // Reassemble all chunks
        let totalLen = 0;
        for (const c of buf.chunks) totalLen += (c ? c.length : 0);
        const full = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of buf.chunks) {
          if (c) { full.set(c, offset); offset += c.length; }
        }
        this._rxBuffer.delete(this._currentMsgKey);
        if (this._onMessage) this._onMessage(full);
      }
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    _handleDisconnect(reason) {
      if (this._onDisconnect) this._onDisconnect(reason);
    }

    _statusUpdate(msg) {
      if (this._onStatus) this._onStatus(msg);
    }
  }

  return { BluetoothTransport, isAvailable };
})();
