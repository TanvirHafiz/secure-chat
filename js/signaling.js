/**
 * signaling.js — WebSocket relay client for WebRTC signaling.
 *
 * This module handles ONLY the SDP/ICE handshake phase.
 * After WebRTC DataChannel opens, this connection should be closed.
 * The relay server never sees any chat message content.
 */

const SecureChatSignaling = (() => {

  class SignalingClient {
    constructor(relayUrl) {
      this._url       = relayUrl;
      this._ws        = null;
      this._handlers  = {};
      this._connected = false;
    }

    /**
     * Connect to relay and join a room.
     * @param {string} roomCode  - Session code (e.g. "TIGER-4829")
     * @param {string} pubKeyB64 - Own ECDH public key in base64
     * @returns {Promise<void>}  - Resolves when connected and join message sent
     */
    connect(roomCode, pubKeyB64) {
      return new Promise((resolve, reject) => {
        try {
          this._ws = new WebSocket(this._url);
        } catch (err) {
          reject(new Error(`Cannot connect to relay: ${err.message}`));
          return;
        }

        const timeout = setTimeout(() => {
          this._ws.close();
          reject(new Error('Relay connection timeout'));
        }, 10000);

        this._ws.addEventListener('open', () => {
          clearTimeout(timeout);
          this._connected = true;
          this._ws.send(JSON.stringify({
            type: 'join',
            room: roomCode,
            pubKey: pubKeyB64,
          }));
          resolve();
        });

        this._ws.addEventListener('message', (event) => {
          let msg;
          try { msg = JSON.parse(event.data); } catch { return; }
          this._dispatch(msg);
        });

        this._ws.addEventListener('close', () => {
          this._connected = false;
          this._dispatch({ type: 'disconnected' });
        });

        this._ws.addEventListener('error', () => {
          clearTimeout(timeout);
          this._connected = false;
          reject(new Error('Relay WebSocket error'));
        });
      });
    }

    send(type, payload) {
      if (!this._connected || !this._ws) return;
      this._ws.send(JSON.stringify({ type, ...payload }));
    }

    sendOffer(sdp)      { this.send('offer',  { sdp }); }
    sendAnswer(sdp)     { this.send('answer', { sdp }); }
    sendIce(candidate)  { this.send('ice',    { candidate }); }

    on(type, handler) {
      this._handlers[type] = handler;
    }

    close() {
      if (this._ws) {
        this._ws.send(JSON.stringify({ type: 'leave' }));
        this._ws.close();
        this._ws = null;
        this._connected = false;
      }
    }

    _dispatch(msg) {
      const handler = this._handlers[msg.type];
      if (handler) handler(msg);
    }
  }

  return { SignalingClient };
})();
