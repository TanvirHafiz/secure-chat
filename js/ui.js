/**
 * ui.js — DOM helpers and screen rendering.
 * All screen content is set via textContent (never innerHTML from untrusted data).
 */

const SecureChatUI = (() => {

  // ── Screen management ─────────────────────────────────────────────────────

  let _currentScreen = null;

  function showScreen(id) {
    if (_currentScreen) _currentScreen.classList.remove('active');
    const el = document.getElementById(`screen-${id}`);
    if (!el) { console.error(`No screen: screen-${id}`); return; }
    el.classList.add('active');
    _currentScreen = el;
  }

  // ── Status bar ────────────────────────────────────────────────────────────

  function setTransport(type) {
    const el = document.getElementById('transport-indicator');
    if (!el) return;
    if (!type) { el.textContent = ''; return; }
    el.textContent = `[${type.toUpperCase()}]`;
  }

  function setConnectionState(state) {
    const el = document.getElementById('connection-state');
    if (el) el.textContent = state || '';
  }

  // ── Session code screen ───────────────────────────────────────────────────

  function setSessionCode(code) {
    const el = document.getElementById('session-code-display');
    if (el) el.textContent = code;
  }

  function setFingerprint(fp) {
    const el = document.getElementById('fingerprint-display');
    if (el) el.textContent = fp ? `KEY: ${fp.toUpperCase()}` : '';
  }

  // ── Key exchange screen ───────────────────────────────────────────────────

  function setKeyStatus(step, state, text) {
    const el = document.getElementById(`key-status-${step}`);
    if (!el) return;
    el.className = `key-status ${state}`;
    const label = el.querySelector('.label');
    if (label) label.textContent = text;
  }

  // ── Connecting screen ─────────────────────────────────────────────────────

  function setStatusText(text) {
    const el = document.getElementById('status-text');
    if (el) el.textContent = text;
  }

  // ── Chat screen ───────────────────────────────────────────────────────────

  function setChatHeader(sessionCode, transportType) {
    const codeEl = document.getElementById('chat-session-code');
    const badgeEl = document.getElementById('chat-transport-badge');
    if (codeEl)  codeEl.textContent  = sessionCode;
    if (badgeEl) badgeEl.textContent = transportType ? transportType.toUpperCase() : '';
  }

  /**
   * Append a message to the chat.
   * @param {string} text       - Message text (treated as plain text, never HTML)
   * @param {'sent'|'received'} direction
   * @param {number} timestamp  - Unix ms
   */
  function appendMessage(text, direction, timestamp) {
    const container = document.getElementById('messages');
    if (!container) return;

    const msgEl  = document.createElement('div');
    msgEl.className = `message ${direction}`;

    const textEl = document.createElement('div');
    textEl.textContent = text; // SECURITY: textContent prevents XSS

    const metaEl = document.createElement('div');
    metaEl.className = 'message-meta';
    metaEl.textContent = _formatTime(timestamp);

    msgEl.appendChild(textEl);
    msgEl.appendChild(metaEl);
    container.appendChild(msgEl);

    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  function appendSystemMessage(text) {
    const container = document.getElementById('messages');
    if (!container) return;

    const el = document.createElement('div');
    el.className = 'system-message';
    el.textContent = text;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  function clearMessages() {
    const container = document.getElementById('messages');
    if (container) container.innerHTML = '';
  }

  // ── Manual SDP screen ─────────────────────────────────────────────────────

  function showManualOffer(offerB64) {
    const el = document.getElementById('offer-sdp-display');
    if (el) el.textContent = offerB64;
  }

  function showManualAnswer(answerB64) {
    const el = document.getElementById('answer-sdp-display');
    if (el) el.textContent = answerB64;
  }

  // ── Error screen ──────────────────────────────────────────────────────────

  function showError(message) {
    const el = document.getElementById('error-message');
    if (el) el.textContent = message; // textContent — no XSS
    showScreen('error');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function getInputValue(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }

  function setInputValue(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity  = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  return {
    showScreen,
    setTransport,
    setConnectionState,
    setSessionCode,
    setFingerprint,
    setKeyStatus,
    setStatusText,
    setChatHeader,
    appendMessage,
    appendSystemMessage,
    clearMessages,
    showManualOffer,
    showManualAnswer,
    showError,
    getInputValue,
    setInputValue,
    copyToClipboard,
  };
})();
