/**
 * session.js — Session code generation and ECDH key exchange orchestration.
 *
 * Session code format: WORD-NNNN  (e.g. "TIGER-4829")
 * The code is shared verbally out-of-band and mixed into HKDF salt,
 * binding the encryption key to the verbally-verified code.
 * This detects MITM attacks: an attacker substituting public keys
 * derives a different key and cannot read or forge messages.
 */

const SecureChatSession = (() => {

  // ── Word list (256 words, phonetically unambiguous) ──────────────────────
  // Words chosen to be: short, distinct when spoken, no homophones,
  // no offensive meanings, clear in noisy environments.
  const WORDS = [
    'AMBER','ANGEL','APPLE','ARROW','ATLAS','AXLE','AZURE',
    'BADGE','BANKS','BARON','BASIL','BATCH','BEARS','BENCH',
    'BIRCH','BLADE','BLANK','BLAZE','BLEND','BLOCK','BLOOM',
    'BLOWN','BLUNT','BOARD','BONDS','BONUS','BOOTH','BRACE',
    'BRAND','BRAVE','BREAD','BRINE','BRISK','BROAD','BROOK',
    'BRUSH','BRUTE','BUILT','BULGE','BUNNY','BURST','CABLE',
    'CAMEL','CANDY','CEDAR','CHAIN','CHALK','CHART','CHASE',
    'CHESS','CHIEF','CHILD','CHIRP','CIVIC','CLAIM','CLAMP',
    'CLANK','CLASH','CLASS','CLEAN','CLEAR','CLERK','CLICK',
    'CLIFF','CLIMB','CLING','CLOCK','CLOSE','CLOTH','CLOUD',
    'CLOUT','CLOWN','CLUBS','CLUMP','COACH','COAST','COBRA',
    'COMET','CORAL','COUNT','COURT','COVER','CRAFT','CRANE',
    'CRANK','CREEK','CREST','CRISP','CROSS','CRUST','CUBIC',
    'CURLY','CYCLE','DAILY','DANCE','DEALS','DELTA','DENSE',
    'DEPTH','DERBY','DIGIT','DISCO','DITCH','DIVER','DIVOT',
    'DOCILE','DOME','DRIFT','DRILL','DRINK','DRIVE','DRONE',
    'DUCHY','DUNES','EAGLE','EIGHT','EMBER','EMPTY','ENDOW',
    'ENJOY','ENTER','ENTRY','EQUAL','EQUIP','EXACT','EXERT',
    'EXTRA','FABLE','FACET','FAITH','FALLS','FANCY','FAULT',
    'FEAST','FETCH','FIELD','FIFTH','FILLY','FINAL','FINCH',
    'FIXED','FJORD','FLANK','FLARE','FLASH','FLASK','FLEET',
    'FLESH','FLICK','FLINT','FLOOD','FLOOR','FLUID','FLUTE',
    'FOCUS','FORGE','FORTE','FORUM','FOUND','FRAME','FRANK',
    'FRESH','FROST','FROZE','FRUGAL','FULLY','FUNGI','GLEAM',
    'GLIDE','GLOBE','GLYPH','GRACE','GRADE','GRAFT','GRAIN',
    'GRAND','GRANT','GRASP','GRASS','GRAVE','GREAT','GREET',
    'GRIND','GROAN','GROIN','GROVE','GROWN','GUAVA','GUILD',
    'GUISE','GUSTO','HABIT','HATCH','HAVEN','HEADS','HELIX',
    'HELPS','HERBS','HINGE','HOIST','HOLLY','HOMER','HONEY',
    'HONOR','HORNS','HOTEL','HUNTS','HUSKY','HYDRA','IDEAL',
    'INBOX','INDEX','INDIE','INFER','INPUT','IONIC','IVORY',
    'JAPAN','JAZZY','JEWEL','JOKER','JOUST','JUDGE','JUMBO',
    'KAYAK','KENYA','KNACK','KNEEL','KNIFE','KNOBS','KOALA',
    'LANCE','LARGE','LASER','LATCH','LEMON','LEVEL','LIGHT',
    'LINKS','LIVER','LOCAL','LODGE','LOGIC','LOTUS','LYRIC',
    'MAGIC','MAKER','MANOR','MAPLE','MARCH','MATCH','MAXIM',
    'MEDAL','MERGE','METRO','MIGHT','MILLS','MINDS','MINOR',
    'MINUS','MIRTH','MITRE','MIXED','MODEL','MONKS','MONTHS',
    'MORAL','MOTIF','MOUNT','MOVER','MURKY','MYRRH','NAVAL',
    'NERVE','NEXUS','NICHE','NINJA','NOBLE','NOTES','NOVEL',
    'NYMPH','OASIS','OCEAN','ORBIT','ORGAN','OTHER','OUGHT',
    'OUTDO','OXIDE','OZONE','PANDA','PANEL','PAPAL','PARKA',
    'PARSE','PARTS','PAVED','PEAKS','PEARL','PEDAL','PETAL',
    'PHASE','PILOT','PINCH','PIXIE','PIXEL','PIVOT','PIXEL',
    'PLAID','PLAIN','PLANK','PLANT','PLAZA','PLUMB','PLUME',
    'PLUNK','PLUSH','POLAR','POLYP','POUCH','POWER','PRISM',
    'PROBE','PRONE','PROSE','PROWL','PROXY','PULSE','PUNCH',
    'PUPIL','PURGE','PYGMY','QUAKE','QUEEN','QUERY','QUEST',
    'QUEUE','QUOTA','QUOTE','RADAR','RADIX','RALLY','RAMEN',
    'RANCH','RANGE','RAPID','RATIO','RAVEN','REACH','REALM',
    'REBEL','RELAX','REMIT','REMIX','RENAL','REPAY','REPEL',
    'RIDER','RIDGE','RIVET','ROBIN','ROBOT','ROCKY','ROOMY',
    'ROYAL','RUGBY','RULER','RUSTY','SAFER','SALVO','SANDY',
    'SAUCE','SAVVY','SCALP','SCAMP','SCARAB','SCENE','SCONE',
    'SCOUT','SEDAN','SERUM','SETUP','SEVEN','SHAFT','SHARK',
    'SHELF','SHIFT','SHIRT','SHOAL','SHOCK','SHORE','SHRUB',
    'SIGMA','SILLY','SIXTH','SIZED','SKILL','SLANT','SLATE',
    'SLEEK','SLEET','SLICK','SLIDE','SLOPE','SLUNK','SMART',
    'SMASH','SNACK','SNAIL','SNAKE','SOLAR','SOLID','SONIC',
    'SORRY','SOUTH','SOVEREIGN','SPARK','SPAWN','SPEED','SPEND',
    'SPICE','SPILL','SPINE','SPIRIT','SPOKE','SPOUT','SPRAY',
    'SPRUCE','SQUALL','SQUAD','SQUAT','STACK','STAGE','STAMP',
    'STAND','STARK','START','STASH','STAVE','STAYS','STEAM',
    'STEEL','STEEP','STEER','STERN','STICK','STILL','STING',
    'STOCK','STOMP','STONE','STORM','STORY','STOVE','STRAW',
    'STRIP','STRUT','STUDY','SUITE','SUPER','SURGE','SWAMP',
    'SWATH','SWEAR','SWEPT','SWIFT','SWIPE','SWORD','TABLE',
    'TALON','TAUNT','TAXES','TEACH','THORN','THOSE','THREE',
    'THREW','THRUM','TIGER','TIGHT','TIMED','TOKEN','TOPIC',
    'TORSO','TOTAL','TOUCH','TOUGH','TOWEL','TOWER','TRACE',
    'TRACK','TRADE','TRAIL','TRAIN','TRAIT','TRAMP','TRAPS',
    'TRAWL','TREAD','TRIAL','TRICK','TRIED','TROOP','TRUCK',
    'TRULY','TRUMP','TRUNK','TRUST','TUNIC','TURBO','TWEAK',
    'TWICE','TWIRL','UNIFY','UNION','UNITY','UNTIL','UPPER',
    'UPSET','URBAN','USEFUL','USHER','USUAL','UTMOST','VALOR',
    'VALVE','VAPID','VAULT','VIBES','VIGIL','VIOLA','VIRAL',
    'VISOR','VISTA','VITAL','VIVID','VIXEN','VOCAL','VOICE',
    'VOTER','WAGER','WATCH','WATER','WEDGE','WHALE','WHEAT',
    'WHEEL','WHERE','WHILE','WHIRL','WHOLE','WINDS','WISPY',
    'WITCH','WOODS','WORLD','WOVEN','WRECK','WRIST','YACHT',
    'YEARN','YODEL','YOUNG','YOUTH','ZESTY','ZIPPY','ZONES',
  ].filter((w, i, arr) => arr.indexOf(w) === i).slice(0, 256); // deduplicate, cap at 256

  // ── Session code helpers ─────────────────────────────────────────────────

  function generateSessionCode() {
    const wordIdx = Math.floor(Math.random() * WORDS.length);
    const num     = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `${WORDS[wordIdx]}-${num}`;
  }

  function validateSessionCode(code) {
    if (typeof code !== 'string') return false;
    const parts = code.toUpperCase().split('-');
    if (parts.length !== 2) return false;
    const [word, num] = parts;
    if (!WORDS.includes(word)) return false;
    if (!/^\d{4}$/.test(num)) return false;
    return true;
  }

  function normalizeSessionCode(code) {
    return code.toUpperCase().trim();
  }

  // ── Session class ────────────────────────────────────────────────────────

  class Session {
    constructor(sessionCode) {
      this._code        = normalizeSessionCode(sessionCode);
      this._keypair     = null;
      this._pubKeyBytes = null;
      this._encKey      = null;
      this._fingerprint = null;
      this._outSeq      = BigInt(0);
      this._inSeq       = BigInt(0);
      this._destroyed   = false;
    }

    get sessionCode() { return this._code; }
    get fingerprint()  { return this._fingerprint; }
    get isReady()      { return this._encKey !== null; }

    /**
     * Generate ECDH keypair and compute own public key bytes + fingerprint.
     * Call this before showing the session code screen.
     * Returns base64-encoded public key for sharing with peer.
     */
    async init() {
      this._assertAlive();
      this._keypair     = await SecureChatCrypto.generateECDHKeypair();
      const spkiBuffer  = await SecureChatCrypto.exportPublicKey(this._keypair.publicKey);
      this._pubKeyBytes = new Uint8Array(spkiBuffer);
      this._fingerprint = await SecureChatCrypto.computeFingerprint(spkiBuffer);
      return SecureChatCrypto.arrayBufferToBase64(spkiBuffer);
    }

    /**
     * Complete key exchange once peer's public key (base64) is received.
     * Derives the shared AES-256-GCM encryption key.
     * Returns true if successful.
     */
    async completeKeyExchange(peerPubKeyBase64) {
      this._assertAlive();
      if (!this._keypair) throw new Error('Session.init() must be called first');

      const peerSpki  = SecureChatCrypto.base64ToArrayBuffer(peerPubKeyBase64);
      const peerPubKey = await SecureChatCrypto.importPublicKey(peerSpki);
      const sessionSalt = await SecureChatCrypto.computeSessionSalt(this._code);

      this._encKey = await SecureChatCrypto.deriveEncryptionKey(
        this._keypair.privateKey,
        peerPubKey,
        sessionSalt
      );

      // Private key no longer needed — allow GC
      this._keypair = { publicKey: this._keypair.publicKey };
      return true;
    }

    /**
     * Encrypt a text message.
     * Returns Uint8Array of encrypted payload (IV + ciphertext).
     */
    async encryptText(text) {
      this._assertReady();
      const payload = new TextEncoder().encode(JSON.stringify({
        text,
        timestamp: Date.now(),
      }));
      const seq = this._outSeq++;
      const { iv, ciphertext } = await SecureChatCrypto.encryptMessage(
        this._encKey, payload, seq
      );
      // Pack: [8 bytes seq][12 bytes IV][N bytes ciphertext]
      return SecureChatCrypto.concatBuffers(
        _seqToBytes(seq), iv, ciphertext
      );
    }

    /**
     * Decrypt a received payload.
     * Returns { text, timestamp } or throws on auth failure.
     */
    async decryptText(encryptedBytes) {
      this._assertReady();
      const buf  = encryptedBytes instanceof ArrayBuffer
        ? new Uint8Array(encryptedBytes) : encryptedBytes;
      const seq  = _bytesToSeq(buf.slice(0, 8));
      const iv   = buf.slice(8, 20);
      const ct   = buf.slice(20);

      // Enforce monotonic sequence to prevent replay
      if (seq !== this._inSeq) {
        throw new Error(`Sequence mismatch: expected ${this._inSeq}, got ${seq}`);
      }
      this._inSeq++;

      const plain = await SecureChatCrypto.decryptMessage(this._encKey, iv, ct, seq);
      return JSON.parse(new TextDecoder().decode(plain));
    }

    /**
     * Create a VERIFY ping message (used to confirm both sides derived the same key).
     * Returns encrypted bytes of the string "VERIFY".
     */
    async createVerifyPing() {
      this._assertReady();
      const payload = new TextEncoder().encode('VERIFY');
      const seq = this._outSeq++;
      const { iv, ciphertext } = await SecureChatCrypto.encryptMessage(
        this._encKey, payload, seq
      );
      return SecureChatCrypto.concatBuffers(_seqToBytes(seq), iv, ciphertext);
    }

    /**
     * Attempt to decrypt a verify ping. Returns true if it decrypts to "VERIFY".
     * Does NOT advance inSeq — used only for the handshake ping.
     */
    async verifyPing(encryptedBytes) {
      this._assertReady();
      const buf = encryptedBytes instanceof ArrayBuffer
        ? new Uint8Array(encryptedBytes) : encryptedBytes;
      const seq = _bytesToSeq(buf.slice(0, 8));
      const iv  = buf.slice(8, 20);
      const ct  = buf.slice(20);
      try {
        const plain = await SecureChatCrypto.decryptMessage(this._encKey, iv, ct, seq);
        const text  = new TextDecoder().decode(plain);
        if (text === 'VERIFY') {
          this._inSeq = seq + BigInt(1); // advance past the verify ping
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }

    /**
     * Wipe all key material. Call on session end.
     */
    destroy() {
      this._encKey      = null;
      this._keypair     = null;
      this._pubKeyBytes = null;
      this._fingerprint = null;
      this._outSeq      = BigInt(0);
      this._inSeq       = BigInt(0);
      this._destroyed   = true;
    }

    _assertAlive() {
      if (this._destroyed) throw new Error('Session has been destroyed');
    }

    _assertReady() {
      this._assertAlive();
      if (!this._encKey) throw new Error('Key exchange not complete');
    }
  }

  // ── Sequence number encoding ─────────────────────────────────────────────

  function _seqToBytes(seq) {
    const buf  = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setBigUint64(0, seq, false);
    return new Uint8Array(buf);
  }

  function _bytesToSeq(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
    return view.getBigUint64(0, false);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    generateSessionCode,
    validateSessionCode,
    normalizeSessionCode,
    Session,
  };
})();
