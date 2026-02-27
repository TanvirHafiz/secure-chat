/**
 * transport.js — Transport abstraction layer.
 *
 * Wraps WebRTC and Bluetooth transports behind a unified interface.
 * The app layer deals only with: connect(), send(), onMessage(), disconnect().
 */

const SecureChatTransport = (() => {

  /**
   * Unified transport wrapper.
   * Delegates to WebRTCTransport or BluetoothTransport based on selected mode.
   */
  class Transport {
    constructor(mode) {
      // mode: 'webrtc-relay' | 'webrtc-manual' | 'bluetooth'
      this.mode = mode;
      this._inner = null;
      this._messageCallbacks   = [];
      this._disconnectCallbacks = [];
      this._statusCallbacks    = [];
    }

    get type() {
      if (this.mode.startsWith('webrtc')) return 'webrtc';
      return 'bluetooth';
    }

    get isConnected() {
      return this._inner ? this._inner.isConnected : false;
    }

    // ── WebRTC relay mode ─────────────────────────────────────────────────

    /**
     * Connect using relay server.
     * Returns { peerPubKeyB64 } once peer joins and pubKeys are exchanged.
     */
    async connectRelayAsHost(sessionCode, ownPubKeyB64, relayUrl) {
      this._inner = new SecureChatWebRTC.WebRTCTransport();
      this._wire();
      return this._inner.connectViaRelay({
        relayUrl,
        sessionCode,
        pubKeyB64: ownPubKeyB64,
        isHost: true,
      });
    }

    async connectRelayAsJoiner(sessionCode, ownPubKeyB64, relayUrl) {
      this._inner = new SecureChatWebRTC.WebRTCTransport();
      this._wire();
      return this._inner.connectViaRelay({
        relayUrl,
        sessionCode,
        pubKeyB64: ownPubKeyB64,
        isHost: false,
      });
    }

    /** Host: create and start WebRTC offer (call after key exchange complete) */
    async startWebRTCOffer() {
      return this._inner.startOffer();
    }

    // ── WebRTC manual mode ────────────────────────────────────────────────

    /** Manual host: generate base64 offer string to share with peer */
    async generateManualOffer() {
      this._inner = new SecureChatWebRTC.WebRTCTransport();
      this._wire();
      return this._inner.generateOffer();
    }

    /** Manual joiner: given host's base64 offer, generate base64 answer */
    async generateManualAnswer(offerB64) {
      this._inner = new SecureChatWebRTC.WebRTCTransport();
      this._wire();
      return this._inner.generateAnswer(offerB64);
    }

    /** Manual host: apply joiner's base64 answer */
    async applyManualAnswer(answerB64) {
      return this._inner.applyAnswer(answerB64);
    }

    // ── Bluetooth mode ────────────────────────────────────────────────────

    /**
     * Bluetooth host: advertise and wait for peer to connect.
     * Returns { peerPubKeyB64 } once peer connects and pubKeys exchanged.
     */
    async connectBluetoothAsHost(sessionCode, ownPubKeyB64) {
      this._inner = new SecureChatBluetooth.BluetoothTransport();
      this._wire();
      return this._inner.hostSession(sessionCode, ownPubKeyB64);
    }

    /**
     * Bluetooth joiner: scan for host and connect.
     * Returns { peerPubKeyB64 } once connected and pubKeys exchanged.
     */
    async connectBluetoothAsJoiner(sessionCode, ownPubKeyB64) {
      this._inner = new SecureChatBluetooth.BluetoothTransport();
      this._wire();
      return this._inner.joinSession(sessionCode, ownPubKeyB64);
    }

    // ── Common interface ──────────────────────────────────────────────────

    /**
     * Wait until the underlying channel is ready to send.
     * Must be awaited before the first send().
     */
    waitForChannel() {
      if (!this._inner) return Promise.reject(new Error('Transport not initialized'));
      if (this._inner.waitForChannel) return this._inner.waitForChannel();
      return Promise.resolve();
    }

    /**
     * Send encrypted binary data to peer.
     * @param {Uint8Array} data - Already encrypted by Session
     */
    send(data) {
      if (!this._inner) throw new Error('Transport not initialized');
      this._inner.send(data);
    }

    onMessage(callback) {
      this._messageCallbacks.push(callback);
    }

    onDisconnect(callback) {
      this._disconnectCallbacks.push(callback);
    }

    onStatus(callback) {
      this._statusCallbacks.push(callback);
    }

    disconnect() {
      if (this._inner) {
        this._inner.disconnect();
        this._inner = null;
      }
    }

    // ── Private ───────────────────────────────────────────────────────────

    _wire() {
      this._inner.onMessage((data) => {
        this._messageCallbacks.forEach(cb => cb(data));
      });
      this._inner.onDisconnect((reason) => {
        this._disconnectCallbacks.forEach(cb => cb(reason));
      });
      this._inner.onStatus((msg) => {
        this._statusCallbacks.forEach(cb => cb(msg));
      });
    }
  }

  return { Transport };
})();
