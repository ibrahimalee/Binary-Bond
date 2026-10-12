'use strict';
const WebSocket = require('ws');

// Wires WebSocket clients to the RoomManager with origin checks, per-IP
// connection caps, join/message rate limits, and heartbeats.
function attachWebSocket(server, { rooms, config, clientIp, isAllowedOrigin, limiters }) {
  const wss = new WebSocket.Server({ noServer: true, maxPayload: 96 * 1024, perMessageDeflate: false });
  const connsPerIp = new Map();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    const ip = clientIp(req);
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) return reject(socket, 403);
    if (!limiters.ws.take(ip)) return reject(socket, 429);
    if ((connsPerIp.get(ip) || 0) >= config.limits.maxConnsPerIp) return reject(socket, 429);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, ip));
  });

  wss.on('connection', (ws, ip) => {
    connsPerIp.set(ip, (connsPerIp.get(ip) || 0) + 1);
    ws.isAlive = true;
    const msgBucket = { tokens: 200, at: Date.now() };
    const conn = {
      roomId: null, peer: null, waiting: false,
      send(obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); },
    };

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      // ~50 msgs/s sustained, 200 burst: plenty for trickle ICE, hostile floods get cut off.
      const now = Date.now();
      msgBucket.tokens = Math.min(200, msgBucket.tokens + ((now - msgBucket.at) / 1000) * 50);
      msgBucket.at = now;
      if (msgBucket.tokens < 1) return ws.close(1008, 'rate limited');
      msgBucket.tokens--;

      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return conn.send({ t: 'error', code: 'bad-json' }); }
      if (msg?.t === 'join' && !limiters.join.take(ip)) return conn.send({ t: 'denied', reason: 'rate-limited' });
      try { rooms.handle(conn, msg); } catch (e) {
        console.error('[ws] handler error:', e.message);
        conn.send({ t: 'error', code: 'internal' });
      }
    });
    ws.on('close', () => {
      rooms.leave(conn);
      const n = (connsPerIp.get(ip) || 1) - 1;
      if (n <= 0) connsPerIp.delete(ip); else connsPerIp.set(ip, n);
    });
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 25000);
  heartbeat.unref?.();

  return {
    wss,
    close() { clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); wss.close(); },
    connections: () => wss.clients.size,
  };
}

function reject(socket, code) {
  socket.write(`HTTP/1.1 ${code} ${code === 403 ? 'Forbidden' : 'Too Many Requests'}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

module.exports = { attachWebSocket };
