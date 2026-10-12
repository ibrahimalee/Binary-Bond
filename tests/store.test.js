const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../api/store');

test('rooms are case-insensitive and reject duplicate codes', () => {
  const code = 'ROOM1234';
  const room = store.createRoom(code.toLowerCase());

  assert.equal(room.code, code.toUpperCase());
  assert.equal(store.createRoom(code.toUpperCase()), null);
  store.clearRoom(code);
});

test('ICE candidates are delivered only to the other participant', () => {
  const code = 'ICE12345';
  store.createRoom(code);
  store.addIceCandidate(code, { candidate: 'candidate-a' }, 'participant-a');
  store.addIceCandidate(code, { candidate: 'candidate-b' }, 'participant-b');

  assert.deepEqual(store.getIceCandidates(code, 'participant-a'), [
    { candidate: { candidate: 'candidate-b' }, senderId: 'participant-b' },
  ]);
  assert.deepEqual(store.getIceCandidates(code, 'participant-b'), [
    { candidate: { candidate: 'candidate-a' }, senderId: 'participant-a' },
  ]);
  store.clearRoom(code);
});

test('room lookup rejects malformed codes and expires stale rooms', () => {
  const code = 'ABCD1234';
  assert.ok(store.createRoom(code));
  assert.equal(store.getRoom('../ABCD1234'), null);

  const room = store.getRoom(code);
  room.createdAt = Date.now() - (61 * 60 * 1000);
  assert.equal(store.getRoom(code), null);
});
