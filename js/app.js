/**
 * app.js — Main application controller and state machine.
 *
 * States: WELCOME → SESSION_CODE → KEY_EXCHANGE → CHAT → SESSION_END
 *                               → MANUAL_SDP (manual WebRTC mode)
 *                               → ERROR
 *
 * All modules (crypto.js, session.js, webrtc.js, bluetooth.js, transport.js, ui.js)
 * must be loaded before this file.
 */

const SecureChatApp = (() => {

  // ── App state ─────────────────────────────────────────────────────────────
  let _session   = null;
  let _transport = null;
  let _mode      = null;   // 'webrtc-relay' | 'webrtc-manual' | 'bluetooth'
  let _isHost    = false;

  const DEFAULT_RELAY = 'wss://secure-chat-fixv.onrender.com';

  // ── Initialization ────────────────────────────────────────────────────────

  function init() {
    _bindWelcomeButtons();
    SecureChatUI.showScreen('welcome');
    SecureChatUI.setConnectionState('');
  }

  // ── Welcome screen ────────────────────────────────────────────────────────

  function _bindWelcomeButtons() {
    _on('btn-start-relay',    () => _startSession('webrtc-relay', true));
    _on('btn-join-relay',     () => _startSession('webrtc-relay', false));
    _on('btn-start-manual',   () => _startSession('webrtc-manual', true));
    _on('btn-join-manual',    () => _startSession('webrtc-manual', false));
    _on('btn-start-bt',       () => _startSession('bluetooth', true));
    _on('btn-join-bt',        () => _startSession('bluetooth', false));
  }

  // ── Session setup ─────────────────────────────────────────────────────────

  async function _startSession(mode, isHost) {
    _mode   = mode;
    _isHost = isHost;

    let sessionCode;

    if (isHost) {
      // Host generates the session code
      sessionCode = SecureChatSession.generateSessionCode();
    } else {
      // Joiner enters the session code
      sessionCode = _promptSessionCode();
      if (!sessionCode) return;
    }

    _session = new SecureChatSession.Session(sessionCode);

    SecureChatUI.showScreen('session-code');
    SecureChatUI.setSessionCode(sessionCode);
    SecureChatUI.setStatusText('Generating keypair…');

    let ownPubKeyB64;
    try {
      ownPubKeyB64 = await _session.init();
      SecureChatUI.setFingerprint(_session.fingerprint);
    } catch (err) {
      SecureChatUI.showError(`Crypto error: ${err.message}`);
      return;
    }

    if (isHost) {
      // Host displays code and waits
      _on('btn-proceed-session', () => _connect(ownPubKeyB64));
      SecureChatUI.setStatusText('Share this code with your peer, then click Connect.');
    } else {
      // Joiner skips straight to connecting
      await _connect(ownPubKeyB64);
    }
  }

  function _promptSessionCode() {
    const raw = prompt('Enter session code (e.g. TIGER-4829):');
    if (!raw) return null;
    const code = SecureChatSession.normalizeSessionCode(raw);
    if (!SecureChatSession.validateSessionCode(code)) {
      alert('Invalid session code format. Expected WORD-NNNN (e.g. TIGER-4829)');
      return null;
    }
    return code;
  }

  // ── Connection ────────────────────────────────────────────────────────────

  async function _connect(ownPubKeyB64) {
    SecureChatUI.showScreen('key-exchange');
    SecureChatUI.setTransport(_mode === 'bluetooth' ? 'Bluetooth' : 'WebRTC');

    _transport = new SecureChatTransport.Transport(_mode);

    _transport.onStatus((msg) => SecureChatUI.setStatusText(msg));
    _transport.onDisconnect((reason) => _onDisconnected(reason));
    _transport.onMessage((data) => _onIncomingMessage(data));

    SecureChatUI.setKeyStatus(1, 'wait', 'Connecting to peer…');

    try {
      let peerPubKeyB64;

      if (_mode === 'webrtc-relay') {
        const relayUrl = SecureChatUI.getInputValue('relay-url-input') || DEFAULT_RELAY;
        if (_isHost) {
          const result = await _transport.connectRelayAsHost(
            _session.sessionCode, ownPubKeyB64, relayUrl
          );
          peerPubKeyB64 = result.peerPubKeyB64;
        } else {
          const result = await _transport.connectRelayAsJoiner(
            _session.sessionCode, ownPubKeyB64, relayUrl
          );
          peerPubKeyB64 = result.peerPubKeyB64;
        }

      } else if (_mode === 'webrtc-manual') {
        peerPubKeyB64 = await _doManualKeyExchange(ownPubKeyB64);
        if (!peerPubKeyB64) return; // user cancelled

      } else if (_mode === 'bluetooth') {
        if (_isHost) {
          const result = await _transport.connectBluetoothAsHost(
            _session.sessionCode, ownPubKeyB64
          );
          if (result.browserLimited) {
            alert(result.message);
            // Fallback: use relay for discovery, then send over BT
            SecureChatUI.showError('Browser Bluetooth advertising not supported. Use Relay mode for initial connection.');
            return;
          }
          peerPubKeyB64 = result.peerPubKeyB64;
        } else {
          const result = await _transport.connectBluetoothAsJoiner(
            _session.sessionCode, ownPubKeyB64
          );
          peerPubKeyB64 = result.peerPubKeyB64;
        }
      }

      // ── Key exchange ────────────────────────────────────────────────────
      SecureChatUI.setKeyStatus(1, 'ok',   'Peer connected');
      SecureChatUI.setKeyStatus(2, 'wait', 'Deriving shared key…');

      await _session.completeKeyExchange(peerPubKeyB64);

      SecureChatUI.setKeyStatus(2, 'ok',   'Shared key derived');
      SecureChatUI.setKeyStatus(3, 'wait', 'Verifying keys…');

      // If we're relay/WebRTC host, now start the WebRTC offer
      if (_mode === 'webrtc-relay' && _isHost) {
        await _transport.startWebRTCOffer();
      }

      // Wait for the DataChannel / Bluetooth channel to actually open
      // before attempting to send the verification ping
      SecureChatUI.setStatusText('Waiting for channel to open…');
      await _transport.waitForChannel();

      // ── Verify keys with encrypted ping ─────────────────────────────────
      await _verifyKeys();

    } catch (err) {
      SecureChatUI.showError(`Connection failed: ${err.message}`);
      _cleanup();
    }
  }

  // ── Manual SDP key exchange flow ──────────────────────────────────────────

  async function _doManualKeyExchange(ownPubKeyB64) {
    return new Promise((resolve, reject) => {
      SecureChatUI.showScreen('manual-sdp');

      if (_isHost) {
        // Show own pubKey, ask for peer's
        SecureChatUI.showManualOffer(ownPubKeyB64);

        _on('btn-manual-got-pubkey', async () => {
          const peerPubKeyB64 = SecureChatUI.getInputValue('manual-peer-pubkey');
          if (!peerPubKeyB64) { alert('Paste peer\'s public key first'); return; }

          // After key exchange, generate WebRTC offer
          try {
            await _session.completeKeyExchange(peerPubKeyB64);
            const offerB64 = await _transport.generateManualOffer();
            SecureChatUI.showManualOffer(offerB64);
            SecureChatUI.setInputValue('manual-peer-pubkey', '');

            // Now wait for the answer
            _on('btn-manual-apply-answer', async () => {
              const answerB64 = SecureChatUI.getInputValue('manual-answer-input');
              if (!answerB64) { alert('Paste peer\'s answer first'); return; }
              await _transport.applyManualAnswer(answerB64);
              resolve(null); // key exchange already done above
            });
          } catch (err) {
            reject(err);
          }
        });

      } else {
        // Joiner: paste host's pubKey, get own pubKey displayed
        SecureChatUI.showManualOffer(ownPubKeyB64);

        _on('btn-manual-generate-answer', async () => {
          const hostPubKeyB64 = SecureChatUI.getInputValue('manual-peer-pubkey');
          const hostOfferB64  = SecureChatUI.getInputValue('manual-offer-input');
          if (!hostPubKeyB64 || !hostOfferB64) {
            alert('Paste host\'s public key and SDP offer first');
            return;
          }

          try {
            const answerB64 = await _transport.generateManualAnswer(hostOfferB64);
            SecureChatUI.showManualAnswer(answerB64);
            resolve(hostPubKeyB64); // return peer's pubKey to continue key exchange
          } catch (err) {
            reject(err);
          }
        });
      }
    });
  }

  // ── Key verification ──────────────────────────────────────────────────────

  async function _verifyKeys() {
    // Protocol: host sends VERIFY ping, joiner verifies and sends back VERIFY ping
    // This confirms both sides derived the same AES key.

    if (_isHost) {
      // Send VERIFY ping
      const ping = await _session.createVerifyPing();
      _transport.send(ping);

      // Wait for peer's VERIFY response (handled in onIncomingMessage)
      await _waitForVerify();
    } else {
      // Joiner: wait for host's VERIFY ping, then respond
      await _waitForVerify();
      const ping = await _session.createVerifyPing();
      _transport.send(ping);
    }
  }

  let _verifyResolve = null;
  let _verifyReject  = null;

  function _waitForVerify() {
    return new Promise((resolve, reject) => {
      _verifyResolve = resolve;
      _verifyReject  = reject;
      setTimeout(() => {
        if (_verifyReject) {
          _verifyReject(new Error('Key verification timeout — possible MITM or wrong session code'));
          _verifyResolve = null;
          _verifyReject  = null;
        }
      }, 15000);
    });
  }

  // ── Incoming messages ─────────────────────────────────────────────────────

  async function _onIncomingMessage(data) {
    // During key verification phase
    if (_verifyResolve) {
      const ok = await _session.verifyPing(data).catch(() => false);
      if (ok) {
        SecureChatUI.setKeyStatus(3, 'ok', 'Keys verified — secure channel established');
        _verifyResolve();
        _verifyResolve = null;
        _verifyReject  = null;
        // Transition to chat after short delay
        setTimeout(_enterChat, 800);
      } else {
        if (_verifyReject) {
          _verifyReject(new Error('Key mismatch — possible MITM attack! Verify session code and retry.'));
          _verifyResolve = null;
          _verifyReject  = null;
        }
      }
      return;
    }

    // Normal chat message
    try {
      const { text, timestamp } = await _session.decryptText(data);
      SecureChatUI.appendMessage(text, 'received', timestamp);
    } catch (err) {
      SecureChatUI.appendSystemMessage('[Message could not be decrypted]');
      console.error('Decrypt error:', err);
    }
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  function _enterChat() {
    SecureChatUI.showScreen('chat');
    SecureChatUI.setChatHeader(_session.sessionCode, _mode === 'bluetooth' ? 'Bluetooth' : 'WebRTC');
    SecureChatUI.setConnectionState('CONNECTED');
    SecureChatUI.clearMessages();
    SecureChatUI.appendSystemMessage('Secure channel established. Messages are end-to-end encrypted.');

    _on('send-btn', _sendMessage);
    _on('chat-end-btn', _endSession);

    const input = document.getElementById('message-input');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          _sendMessage();
        }
      });
      input.focus();
    }
  }

  async function _sendMessage() {
    const input = document.getElementById('message-input');
    const text  = input ? input.value.trim() : '';
    if (!text) return;

    try {
      const encrypted = await _session.encryptText(text);
      _transport.send(encrypted);
      SecureChatUI.appendMessage(text, 'sent', Date.now());
      if (input) input.value = '';
    } catch (err) {
      SecureChatUI.appendSystemMessage(`[Send failed: ${err.message}]`);
    }
  }

  // ── Session end ───────────────────────────────────────────────────────────

  function _endSession() {
    if (!confirm('End this session? All encryption keys will be permanently deleted.')) return;
    _cleanup();
    SecureChatUI.showScreen('session-end');
    SecureChatUI.setConnectionState('');
    SecureChatUI.setTransport('');
    _on('btn-new-session', () => {
      SecureChatUI.showScreen('welcome');
    });
  }

  function _onDisconnected(reason) {
    if (_session) {
      SecureChatUI.appendSystemMessage(`Connection lost: ${reason}`);
      SecureChatUI.setConnectionState('DISCONNECTED');
    }
  }

  function _cleanup() {
    if (_session)   { _session.destroy();    _session   = null; }
    if (_transport) { _transport.disconnect(); _transport = null; }
    _mode   = null;
    _isHost = false;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _on(id, handler) {
    const el = document.getElementById(id);
    if (!el) return;
    // Clone to remove old listeners
    const fresh = el.cloneNode(true);
    el.parentNode.replaceChild(fresh, el);
    fresh.addEventListener('click', handler);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return { init };

})();

// Boot when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  SecureChatApp.init();
});
