// End-to-end key handling. The room secret lives only in the URL fragment
// (never sent to the server). Everything else is derived from it with HKDF:
//
//   secret ──HKDF──► roomId   (public: server routing key)
//          ├─HKDF──► authKey  (server stores only sha256(authKey))
//          └─HKDF──► encKey   (AES-256-GCM, never leaves the browser)
//
// The server therefore can route and gate membership, but cannot read or
// forge signaling (SDP fingerprints included), which prevents a malicious
// server from inserting itself as a man-in-the-middle.

import { enc, dec, b64u, unb64u, randomBytes } from './util.js';

const subtle = globalThis.crypto.subtle;
const INFO = (label) => enc.encode(`binarybond/v2/${label}`);
const SECRET_RE = /^[A-Za-z0-9_-]{22,64}$/;

export const PBKDF2_ITERATIONS = 600_000;

export function newSecret() { return b64u(randomBytes(16)); }
export const isSecret = (s) => typeof s === 'string' && SECRET_RE.test(s);

async function hkdf(base, label, bytes) {
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: INFO(label) }, base, bytes * 8));
}

export async function deriveRoom(secret) {
  if (!isSecret(secret)) throw new Error('invalid room secret');
  const base = await subtle.importKey('raw', unb64u(secret), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const roomId = b64u(await hkdf(base, 'room-id', 18));
  const auth = b64u(await hkdf(base, 'auth', 32));
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: INFO('enc') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  return { roomId, auth, key };
}

// Lets two people meet with nothing but a room name and a shared passphrase
// (no link). PBKDF2 makes offline guessing of weak passphrases expensive.
export async function secretFromPassphrase(roomName, passphrase, iterations = PBKDF2_ITERATIONS) {
  const name = String(roomName).trim().toLowerCase().normalize('NFKC');
  const pass = String(passphrase).normalize('NFKC');
  if (!name || pass.length < 8) throw new Error('room name and a passphrase of 8+ characters are required');
  const base = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`binarybond/v2/pass/${name}`), iterations }, base, 128);
  return b64u(new Uint8Array(bits));
}

// AES-GCM with associated data. For relayed signaling the AAD is "from|to", so
// a server can't silently redirect a message meant for one peer to another.
export async function seal(key, value, aad = '') {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64u(out);
}

export async function open(key, sealed, aad = '') {
  const bytes = unb64u(sealed);
  if (bytes.length < 29) throw new Error('ciphertext too short');
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: enc.encode(aad) }, key, bytes.subarray(12));
  return JSON.parse(dec.decode(pt));
}

export async function sha256Hex(data) {
  const buf = typeof data === 'string' ? enc.encode(data) : data;
  return [...new Uint8Array(await subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---- Safety numbers ---------------------------------------------------------
// Both sides hash the two DTLS certificate fingerprints that actually secure the
// media/data connection. If the codes match out loud, nobody is in the middle.

const EMOJI = [
  '🐶', '🐱', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦉',
  '🦄', '🐝', '🦋', '🐢', '🐙', '🦀', '🐬', '🐳', '🌵', '🌲', '🌻', '🍄', '🌙', '⭐', '🔥', '🌈',
  '🍎', '🍋', '🍉', '🍇', '🍓', '🥑', '🥕', '🌽', '🍕', '🍩', '🎂', '☕', '⚽', '🏀', '🎸', '🎹',
  '🚀', '✈️', '🚲', '⛵', '🏠', '🔑', '🔔', '🎁', '📚', '✏️', '⏰', '💡', '🧲', '🎈', '🧩', '💎',
];

export function fingerprintsFromSdp(sdp) {
  return [...new Set((String(sdp).match(/a=fingerprint:\S+ [0-9A-Fa-f:]+/g) || []).map(l => l.slice(14).toUpperCase()))];
}

export async function safetyCode(fingerprintsA, fingerprintsB) {
  const material = [fingerprintsA.join(','), fingerprintsB.join(',')].sort().join('|');
  const h = await sha256Hex('binarybond/v2/sas|' + material);
  const emoji = [];
  for (let i = 0; i < 6; i++) emoji.push(EMOJI[parseInt(h.slice(i * 2, i * 2 + 2), 16) % 64]);
  const digits = (BigInt('0x' + h.slice(16, 32)) % 10n ** 12n).toString().padStart(12, '0').replace(/(\d{4})(?=\d)/g, '$1 ');
  return { emoji, digits };
}
