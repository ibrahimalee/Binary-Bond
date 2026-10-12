'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startServer, client, roomCreds } = require('./helpers');

async function until(fn, ms = 1000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise(r => setTimeout(r, 10));
  }
}

test('room lifecycle over websockets', async (t) => {
  const bb = await startServer();
  t.after(() => bb.close());

  await t.test('first joiner creates and hosts the room', async () => {
    const creds = roomCreds();
    const a = await client(bb);
    a.send({ t: 'join', ...creds, hello: 'aGVsbG8' });
    const j = await a.next('joined');
    assert.equal(j.host, j.peer);
    assert.deepEqual(j.peers, []);
    assert.equal(j.ice[0].urls[0], 'stun:stun.example.test:3478');
    assert.equal(j.maxPeers, 4);

    const b = await client(bb);
    b.send({ t: 'join', ...creds, hello: 'Ym9i' });
    const jb = await b.next('joined');
    assert.equal(jb.host, j.peer);
    assert.deepEqual(jb.peers, [{ peer: j.peer, hello: 'aGVsbG8' }]);
    const pj = await a.next('peer-joined');
    assert.equal(pj.peer, jb.peer);
    assert.equal(pj.hello, 'Ym9i');

    // Opaque relay in both directions, sender id is server-asserted.
    a.send({ t: 'relay', to: jb.peer, ct: 'Y2lwaGVy' });
    assert.deepEqual(await b.next('relay'), { t: 'relay', from: j.peer, ct: 'Y2lwaGVy' });
    b.send({ t: 'relay', to: j.peer, ct: 'YmFjaw' });
    assert.equal((await a.next('relay')).from, jb.peer);

    // Host leaves: b is promoted.
    await a.close();
    assert.equal((await b.next('peer-left')).peer, j.peer);
    assert.equal((await b.next('host')).peer, jb.peer);
    await b.close();
    await until(() => bb.rooms.rooms.size === 0);
  });

  await t.test('wrong auth key is denied', async () => {
    const creds = roomCreds();
    const a = await client(bb);
    a.send({ t: 'join', ...creds });
    await a.next('joined');
    const b = await client(bb);
    b.send({ t: 'join', room: creds.room, auth: crypto.randomBytes(32).toString('base64url') });
    assert.equal((await b.next('denied')).reason, 'auth');
    await Promise.all([a.close(), b.close()]);
  });

  await t.test('malformed joins and relays are rejected', async () => {
    const a = await client(bb);
    a.send({ t: 'join', room: '../etc', auth: 'x' });
    assert.equal((await a.next('denied')).reason, 'invalid');
    a.send({ t: 'relay', to: 'abc', ct: 'x' });
    assert.equal((await a.next('error')).code, 'not-joined');
    a.ws.send('not json');
    assert.equal((await a.next('error')).code, 'bad-json');
    await a.close();
  });

  await t.test('room capacity is enforced', async () => {
    const creds = roomCreds();
    const cs = [];
    for (let i = 0; i < 2; i++) {
      const c = await client(bb);
      c.send({ t: 'join', ...creds, opts: i === 0 ? { maxPeers: 2 } : undefined });
      await c.next('joined');
      cs.push(c);
    }
    const x = await client(bb);
    x.send({ t: 'join', ...creds });
    assert.equal((await x.next('denied')).reason, 'full');
    await Promise.all([...cs, x].map(c => c.close()));
  });

  await t.test('waiting room: knock, admit, reject', async () => {
    const creds = roomCreds();
    const host = await client(bb);
    host.send({ t: 'join', ...creds, opts: { wait: true } });
    const hj = await host.next('joined');
    assert.equal(hj.wait, true);

    const g = await client(bb);
    g.send({ t: 'join', ...creds, hello: 'Z3Vlc3Q' });
    const w = await g.next('waiting');
    const knock = await host.next('knock');
    assert.equal(knock.peer, w.peer);
    assert.equal(knock.hello, 'Z3Vlc3Q');

    // Guests in the lobby can't relay.
    g.send({ t: 'relay', to: hj.peer, ct: 'eA' });
    assert.equal((await g.next('error')).code, 'not-joined');

    host.send({ t: 'admit', peer: w.peer, ok: true });
    const gj = await g.next('joined');
    assert.equal(gj.peer, w.peer);
    await host.next('peer-joined');

    const r = await client(bb);
    r.send({ t: 'join', ...creds });
    const rw = await r.next('waiting');
    await host.next('knock');
    host.send({ t: 'admit', peer: rw.peer, ok: false });
    assert.equal((await r.next('denied')).reason, 'rejected');

    // Only the host may admit/kick/lock.
    g.send({ t: 'settings', locked: true });
    assert.equal((await g.next('error')).code, 'not-host');
    await Promise.all([host.close(), g.close(), r.close()]);
  });

  await t.test('lock, kick and host-ended', async () => {
    const creds = roomCreds();
    const host = await client(bb);
    host.send({ t: 'join', ...creds });
    await host.next('joined');
    const g = await client(bb);
    g.send({ t: 'join', ...creds });
    const gj = await g.next('joined');

    host.send({ t: 'settings', locked: true });
    assert.equal((await g.next('settings')).locked, true);
    const late = await client(bb);
    late.send({ t: 'join', ...creds });
    assert.equal((await late.next('denied')).reason, 'locked');

    host.send({ t: 'kick', peer: gj.peer });
    assert.equal((await g.next('denied')).reason, 'kicked');
    assert.equal((await host.next('peer-left')).peer, gj.peer);

    host.send({ t: 'settings', locked: false });
    const g2 = await client(bb);
    g2.send({ t: 'join', ...creds });
    await g2.next('joined');
    host.send({ t: 'end' });
    assert.equal((await g2.next('ended')).reason, 'host-ended');
    assert.equal(bb.rooms.rooms.size, 0);
    await Promise.all([host.close(), g.close(), late.close(), g2.close()]);
  });

  await t.test('cross-origin websocket upgrades are refused', async () => {
    await assert.rejects(client(bb, { origin: 'https://evil.example' }));
  });
});

test('rooms expire at their time limit', async (t) => {
  const bb = await startServer({ plans: { public: { maxMinutes: 1 } } });
  t.after(() => bb.close());
  const creds = roomCreds();
  const a = await client(bb);
  a.send({ t: 'join', ...creds });
  const j = await a.next('joined');
  assert.ok(j.expiresAt - Date.now() <= 60000);
  const room = bb.rooms.rooms.get(creds.room);
  bb.rooms._destroy(room, 'expired'); // simulate the timer firing
  assert.equal((await a.next('ended')).reason, 'expired');
  await a.close();
});

test('join attempts are rate limited per IP', async (t) => {
  const bb = await startServer({ limits: { joinsPerIpPerMin: 3 } });
  t.after(() => bb.close());
  const a = await client(bb);
  for (let i = 0; i < 3; i++) { a.send({ t: 'join', room: 'x', auth: 'y' }); await a.next('denied'); }
  a.send({ t: 'join', room: 'x', auth: 'y' });
  assert.equal((await a.next('denied')).reason, 'rate-limited');
  await a.close();
});
