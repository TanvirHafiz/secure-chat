/**
 * crypto.js — All cryptographic operations via Web Crypto API only.
 * No external libraries. Zero server-side involvement.
 *
 * Protocol:
 *   ECDH P-256  →  HKDF-SHA-256  →  AES-256-GCM
 *   Session code is mixed into HKDF salt to bind encryption key
 *   to the verbally-verified session code (MITM detection).
 */

const SecureChatCrypto = (() => {
  const ECDH_CURVE    = 'P-256';
  const HKDF_HASH     = 'SHA-256';
  const AES_ALG       = 'AES-GCM';
  const AES_LEN       = 256;
  const IV_BYTES      = 12;
  const SALT_PREFIX   = 'secure-chat-v1|';
  const HKDF_INFO     = new TextEncoder().encode('secure-chat-v1-aes-gcm-256');

  // ── Key generation ────────────────────────────────────────────────────────

  async function generateECDHKeypair() {
    return crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: ECDH_CURVE },
      false,          // private key not extractable
      ['deriveKey', 'deriveBits']
    );
  }

  async function exportPublicKey(publicKey) {
    // Returns raw SPKI bytes as ArrayBuffer
    return crypto.subtle.exportKey('spki', publicKey);
  }

  async function importPublicKey(spkiBuffer) {
    return crypto.subtle.importKey(
      'spki',
      spkiBuffer,
      { name: 'ECDH', namedCurve: ECDH_CURVE },
      true,
      []   // public key has no usages in ECDH (only private key has deriveBits)
    );
  }

  // ── Key derivation ────────────────────────────────────────────────────────

  /**
   * Compute the session salt: SHA-256("secure-chat-v1|<sessionCode>")
   * Binding the session code to HKDF salt means a MITM substituting
   * public keys will derive a DIFFERENT key, making their relay useless.
   */
  async function computeSessionSalt(sessionCode) {
    const encoded = new TextEncoder().encode(SALT_PREFIX + sessionCode);
    return crypto.subtle.digest(HKDF_HASH, encoded);
  }

  /**
   * Derive shared secret bits via ECDH, then derive AES-256-GCM key via HKDF.
   * Returns a non-extractable CryptoKey for AES-256-GCM.
   */
  async function deriveEncryptionKey(privateKey, peerPublicKey, sessionSalt) {
    // Step 1: Raw ECDH shared secret bits
    const rawBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerPublicKey },
      privateKey,
      256
    );

    // Step 2: Import bits as HKDF key material
    const hkdfKey = await crypto.subtle.importKey(
      'raw',
      rawBits,
      { name: 'HKDF' },
      false,
      ['deriveKey']
    );

    // Step 3: Derive AES-256-GCM key via HKDF
    const aesKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: HKDF_HASH,
        salt: sessionSalt,
        info: HKDF_INFO,
      },
      hkdfKey,
      { name: AES_ALG, length: AES_LEN },
      false,     // non-extractable — cannot be read back from memory via JS
      ['encrypt', 'decrypt']
    );

    // Zero out raw bits from JS memory (key now lives in browser's crypto engine)
    const view = new Uint8Array(rawBits);
    for (let i = 0; i < view.length; i++) view[i] = 0;

    return aesKey;
  }

  // ── Encryption / Decryption ───────────────────────────────────────────────

  function generateIV() {
    return crypto.getRandomValues(new Uint8Array(IV_BYTES));
  }

  /**
   * Encrypt plaintext bytes.
   * seqNum (BigInt or Number) is encoded as 8-byte big-endian AAD.
   * Returns: { iv: Uint8Array(12), ciphertext: Uint8Array (includes 16-byte GCM tag) }
   */
  async function encryptMessage(aesKey, plaintextBytes, seqNum) {
    const iv  = generateIV();
    const aad = encodeSeqNum(seqNum);

    const cipherBuffer = await crypto.subtle.encrypt(
      { name: AES_ALG, iv, additionalData: aad },
      aesKey,
      plaintextBytes
    );

    return { iv, ciphertext: new Uint8Array(cipherBuffer) };
  }

  /**
   * Decrypt ciphertext bytes (with appended GCM tag).
   * Throws if auth fails (wrong key, tampered data, or wrong seqNum).
   */
  async function decryptMessage(aesKey, iv, ciphertext, seqNum) {
    const aad = encodeSeqNum(seqNum);

    const plainBuffer = await crypto.subtle.decrypt(
      { name: AES_ALG, iv, additionalData: aad },
      aesKey,
      ciphertext
    );

    return new Uint8Array(plainBuffer);
  }

  // ── Fingerprint ───────────────────────────────────────────────────────────

  /**
   * Compute a short hex fingerprint of a public key for visual verification.
   * Returns 16 hex characters (64 bits).
   */
  async function computeFingerprint(spkiBuffer) {
    const hash = await crypto.subtle.digest('SHA-256', spkiBuffer);
    return Array.from(new Uint8Array(hash).slice(0, 8))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function encodeSeqNum(seqNum) {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    // BigInt to handle sequence numbers > 2^32
    const big = typeof seqNum === 'bigint' ? seqNum : BigInt(seqNum);
    view.setBigUint64(0, big, false); // big-endian
    return buf;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToArrayBuffer(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function concatBuffers(...arrays) {
    const total = arrays.reduce((n, a) => n + a.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const arr of arrays) {
      out.set(new Uint8Array(arr), offset);
      offset += arr.byteLength;
    }
    return out;
  }

  return {
    generateECDHKeypair,
    exportPublicKey,
    importPublicKey,
    computeSessionSalt,
    deriveEncryptionKey,
    generateIV,
    encryptMessage,
    decryptMessage,
    computeFingerprint,
    arrayBufferToBase64,
    base64ToArrayBuffer,
    concatBuffers,
  };
})();
