'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../public/js/crypto.js');

test('room derivation is deterministic and separates id, auth and key', async () => {
  const { newSecret, deriveRoom, isSecret } = await load();
  const s = newSecret();
  assert.ok(isSecret(s));
  const a = await deriveRoom(s), b = await deriveRoom(s), c = await deriveRoom(newSecret());
  assert.equal(a.roomId, b.roomId);
  assert.equal(a.auth, b.auth);
  assert.notEqual(a.roomId, c.roomId);
  assert.notEqual(a.roomId, a.auth.slice(0, a.roomId.length));
  assert.match(a.roomId, /^[A-Za-z0-9_-]{22,64}$/, 'room id must satisfy the server pattern');
  assert.match(a.auth, /^[A-Za-z0-9_-]{43,88}$/, 'auth must satisfy the server pattern');
  assert.equal(a.key.extractable, false, 'encryption key must not be extractable');
  await assert.rejects(deriveRoom('short'));
});

test('seal/open round-trips and rejects wrong AAD, wrong key and tampering', async () => {
  const { newSecret, deriveRoom, seal, open } = await load();
  const { key } = await deriveRoom(newSecret());
  const { key: other } = await deriveRoom(newSecret());
  const msg = { k: 'sdp', d: { type: 'offer', sdp: 'v=0…' } };
  const ct = await seal(key, msg, 'alice|bob');
  assert.deepEqual(await open(key, ct, 'alice|bob'), msg);
  await assert.rejects(open(key, ct, 'alice|carol'), 'server must not be able to re-route');
  await assert.rejects(open(other, ct, 'alice|bob'));
  const flipped = ct.slice(0, 20) + (ct[20] === 'A' ? 'B' : 'A') + ct.slice(21);
  await assert.rejects(open(key, flipped, 'alice|bob'));
  assert.notEqual(await seal(key, msg, 'x'), await seal(key, msg, 'x'), 'IVs must be random');
});

test('passphrase rooms are deterministic and normalised', async () => {
  const { secretFromPassphrase, isSecret } = await load();
  const a = await secretFromPassphrase('Sunday Standup ', 'correct horse battery', 1000);
  const b = await secretFromPassphrase('sunday standup', 'correct horse battery', 1000);
  const c = await secretFromPassphrase('sunday standup', 'correct horse battery!', 1000);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(isSecret(a));
  await assert.rejects(secretFromPassphrase('room', 'short', 1000));
});

test('safety codes are symmetric and depend on both fingerprints', async () => {
  const { safetyCode, fingerprintsFromSdp } = await load();
  const sdpA = 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\na=fingerprint:sha-256 AA:BB:CC\r\n';
  const sdpB = 'v=0\r\na=fingerprint:sha-256 11:22:33\r\n';
  const fa = fingerprintsFromSdp(sdpA), fb = fingerprintsFromSdp(sdpB);
  assert.deepEqual(fa, ['SHA-256 AA:BB:CC']);
  const x = await safetyCode(fa, fb), y = await safetyCode(fb, fa);
  assert.deepEqual(x, y);
  assert.equal(x.groups.length, 4);
  assert.match(x.digits, /^\d{5} \d{5} \d{5} \d{5}$/);
  const z = await safetyCode(fa, ['SHA-256 11:22:34']);
  assert.notDeepEqual(x, z);
});

test('qr encoder picks the smallest version and stays square', async () => {
  const { encodeQR } = await import('../public/js/qr.js');
  const a = encodeQR('x');
  assert.equal(a.version, 1);
  assert.equal(a.size, 21);
  const b = encodeQR('https://example.com/#' + 'k'.repeat(22));
  assert.ok(b.version >= 3 && b.version <= 4);
  assert.equal(b.modules.length, b.size);
  assert.throws(() => encodeQR('x'.repeat(400)));
});
