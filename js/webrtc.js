/**
 * webrtc.js — WebRTC DataChannel transport.
 *
 * Supports two signaling modes:
 *   'relay'  — Uses WebSocket relay server (LAN or internet)
 *   'manual' — Copy-paste SDP offer/answer (fully offline)
 *
 * Once DataChannel is open, all messages are binary (Uint8Array),
 * already encrypted by session.js before being passed here.
 *
 * On LAN without internet: set iceServers to [] and use local relay
 *   → WebRTC host ICE candidates work on same WiFi network.
 */

const SecureChatWebRTC = (() => {

  // No STUN by default — works on LAN. Add stun:stun.l.google.com:19302 for internet.
  const DEFAULT_ICE = [];

  class WebRTCTransport {
    constructor() {
      this._pc          = null;
      this._dc          = null;
      this._signaling   = null;
      this._onMessage   = null;
      this._onDisconnect = null;
      this._onStatus    = null;
      this._iceBuffer   = [];  // buffer ICE candidates until remote desc is set
      this._remoteDescSet = false;
      this.type = 'webrtc';
    }

    get isConnected() {
      return this._dc && this._dc.readyState === 'open';
    }

    get latency() {
      // Can be retrieved via getStats() but keep it simple for now
      return null;
    }

    // ── Relay mode ─────────────────────────────────────────────────────────

    /**
     * Connect via relay server.
     * @param {object} opts
     *   opts.relayUrl   - WebSocket URL of relay server
     *   opts.sessionCode - Session code string
     *   opts.pubKeyB64   - Own public key in base64
     *   opts.isHost      - true = create offer, false = wait for offer
     */
    async connectViaRelay(opts) {
      const { relayUrl, sessionCode, pubKeyB64, isHost } = opts;

      this._signaling = new SecureChatSignaling.SignalingClient(relayUrl);
      this._setupPeerConnection(isHost);

      return new Promise(async (resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 60000);

        this._signaling.on('waiting', () => {
          this._statusUpdate('Waiting for peer to join…');
        });

        this._signaling.on('peer_joined', async (msg) => {
          this._statusUpdate('Peer connected — exchanging keys…');
          resolve({ peerPubKeyB64: msg.pubKey });

          if (isHost) {
            // Host creates the WebRTC offer after key exchange is done
            // (caller handles key exchange, then calls startOffer)
          }
        });

        this._signaling.on('offer', async (msg) => {
          if (isHost) return; // hosts send offers, don't receive them
          await this._pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
          this._remoteDescSet = true;
          await this._flushIceBuffer();
          const answer = await this._pc.createAnswer();
          await this._pc.setLocalDescription(answer);
          this._signaling.sendAnswer(answer.sdp);
        });

        this._signaling.on('answer', async (msg) => {
          if (!isHost) return;
          await this._pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
          this._remoteDescSet = true;
          await this._flushIceBuffer();
        });

        this._signaling.on('ice', async (msg) => {
          if (msg.candidate) {
            const candidate = typeof msg.candidate === 'string'
              ? JSON.parse(msg.candidate) : msg.candidate;
            if (this._remoteDescSet) {
              await this._pc.addIceCandidate(candidate).catch(() => {});
            } else {
              this._iceBuffer.push(candidate);
            }
          }
        });

        this._signaling.on('peer_left', () => {
          clearTimeout(timeout);
          this._handleDisconnect('Peer disconnected');
        });

        this._signaling.on('error', (msg) => {
          clearTimeout(timeout);
          reject(new Error(msg.message || 'Relay error'));
        });

        this._signaling.on('disconnected', () => {
          // Relay disconnecting is fine once DataChannel is open
        });

        try {
          await this._signaling.connect(sessionCode, pubKeyB64);
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }

            // DataChannel open resolves the channel-ready promise (separate from peer_joined)
        this._dcResolve = () => { clearTimeout(timeout); };
      });
    }

    /**
     * After key exchange is complete (relay mode, host side), create WebRTC offer.
     */
    async startOffer() {
      const offer = await this._pc.createOffer();
      await this._pc.setLocalDescription(offer);
      this._signaling.sendOffer(offer.sdp);
    }

    // ── Manual (copy-paste) mode ────────────────────────────────────────────

    /**
     * Generate an offer SDP for manual mode (host side).
     * Returns base64-encoded offer string to copy to peer.
     */
    async generateOffer() {
      this._setupPeerConnection(true);
      const offer = await this._pc.createOffer();
      await this._pc.setLocalDescription(offer);

      // Collect ICE candidates before returning
      await this._waitForIceGathering();
      return btoa(this._pc.localDescription.sdp);
    }

    /**
     * Given a base64 offer SDP, generate an answer SDP.
     * Returns base64-encoded answer string to copy back to host.
     */
    async generateAnswer(offerB64) {
      this._setupPeerConnection(false);
      const sdp = atob(offerB64);
      await this._pc.setRemoteDescription({ type: 'offer', sdp });
      this._remoteDescSet = true;
      const answer = await this._pc.createAnswer();
      await this._pc.setLocalDescription(answer);

      await this._waitForIceGathering();
      return btoa(this._pc.localDescription.sdp);
    }

    /**
     * Host applies the answer SDP from peer (manual mode).
     */
    async applyAnswer(answerB64) {
      const sdp = atob(answerB64);
      await this._pc.setRemoteDescription({ type: 'answer', sdp });
      this._remoteDescSet = true;
    }

    // ── Wait for channel ────────────────────────────────────────────────────

    /**
     * Returns a Promise that resolves when the DataChannel is open.
     * Must be awaited before calling send() for the first time.
     */
    waitForChannel() {
      if (this.isConnected) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('DataChannel open timeout — check firewall or try manual mode')),
          45000
        );
        this._channelOpenResolve = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
    }

    // ── Sending / receiving ─────────────────────────────────────────────────

    /**
     * Send encrypted binary data to peer.
     * @param {Uint8Array} data
     */
    send(data) {
      if (!this.isConnected) throw new Error('DataChannel not open');
      this._dc.send(data);
    }

    onMessage(callback) {
      this._onMessage = callback;
    }

    onDisconnect(callback) {
      this._onDisconnect = callback;
    }

    onStatus(callback) {
      this._onStatus = callback;
    }

    disconnect() {
      if (this._signaling) { this._signaling.close(); this._signaling = null; }
      if (this._dc)         { this._dc.close();        this._dc = null; }
      if (this._pc)         { this._pc.close();        this._pc = null; }
    }

    // ── Internal ────────────────────────────────────────────────────────────

    _setupPeerConnection(isHost) {
      this._pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE });

      // ICE candidate → send to peer
      this._pc.addEventListener('icecandidate', (event) => {
        if (!event.candidate) return;
        const candidate = JSON.stringify(event.candidate.toJSON());
        if (this._signaling) {
          this._signaling.sendIce(candidate);
        }
        // In manual mode, ICE is embedded in SDP via waitForIceGathering
      });

      this._pc.addEventListener('connectionstatechange', () => {
        const state = this._pc.connectionState;
        this._statusUpdate(`Connection: ${state}`);
        if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          this._handleDisconnect(state);
        }
      });

      if (isHost) {
        // Host creates DataChannel
        this._dc = this._pc.createDataChannel('secure-chat', {
          ordered: true,
        });
        this._setupDataChannel(this._dc);
      } else {
        // Joiner receives DataChannel
        this._pc.addEventListener('datachannel', (event) => {
          this._dc = event.channel;
          this._setupDataChannel(this._dc);
        });
      }
    }

    _setupDataChannel(dc) {
      dc.binaryType = 'arraybuffer';

      dc.addEventListener('open', () => {
        this._statusUpdate('DataChannel open');
        if (this._dcResolve) this._dcResolve();
        if (this._channelOpenResolve) {
          this._channelOpenResolve();
          this._channelOpenResolve = null;
        }
        // Close relay connection — it's no longer needed
        if (this._signaling) {
          this._signaling.close();
          this._signaling = null;
        }
      });

      dc.addEventListener('message', (event) => {
        if (this._onMessage) {
          this._onMessage(new Uint8Array(event.data));
        }
      });

      dc.addEventListener('close', () => {
        this._handleDisconnect('DataChannel closed');
      });

      dc.addEventListener('error', (err) => {
        this._handleDisconnect(`DataChannel error: ${err.message}`);
      });
    }

    async _flushIceBuffer() {
      for (const candidate of this._iceBuffer) {
        await this._pc.addIceCandidate(candidate).catch(() => {});
      }
      this._iceBuffer = [];
    }

    _waitForIceGathering() {
      return new Promise((resolve) => {
        if (this._pc.iceGatheringState === 'complete') { resolve(); return; }
        const check = () => {
          if (this._pc.iceGatheringState === 'complete') {
            this._pc.removeEventListener('icegatheringstatechange', check);
            resolve();
          }
        };
        this._pc.addEventListener('icegatheringstatechange', check);
        // Timeout fallback at 5s (some browsers don't emit 'complete')
        setTimeout(resolve, 5000);
      });
    }

    _handleDisconnect(reason) {
      if (this._onDisconnect) this._onDisconnect(reason);
    }

    _statusUpdate(msg) {
      if (this._onStatus) this._onStatus(msg);
    }
  }

  return { WebRTCTransport };
})();
