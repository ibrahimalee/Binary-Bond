'use strict';
// Minimal RFC 5389 STUN binding responder. Running it lets a deployment avoid
// leaking every participant's IP to a third-party STUN provider.
const dgram = require('dgram');
const net = require('net');

const MAGIC = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const XOR_MAPPED_ADDRESS = 0x0020;

function buildResponse(request, address, port) {
  if (request.length < 20) return null;
  if (request.readUInt16BE(0) !== BINDING_REQUEST || request.readUInt32BE(4) !== MAGIC) return null;
  const txId = request.subarray(8, 20);
  const v4 = net.isIPv4(address);
  const addrLen = v4 ? 4 : 16;
  const attr = Buffer.alloc(4 + 4 + addrLen);
  attr.writeUInt16BE(XOR_MAPPED_ADDRESS, 0);
  attr.writeUInt16BE(4 + addrLen, 2);
  attr.writeUInt8(0, 4);
  attr.writeUInt8(v4 ? 0x01 : 0x02, 5);
  attr.writeUInt16BE(port ^ (MAGIC >>> 16), 6);
  const xorKey = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), txId]);
  const raw = v4 ? Buffer.from(address.split('.').map(Number)) : ipv6ToBuffer(address);
  for (let i = 0; i < addrLen; i++) attr[8 + i] = raw[i] ^ xorKey[i];
  const header = Buffer.alloc(20);
  header.writeUInt16BE(BINDING_SUCCESS, 0);
  header.writeUInt16BE(attr.length, 2);
  header.writeUInt32BE(MAGIC, 4);
  txId.copy(header, 8);
  return Buffer.concat([header, attr]);
}

function ipv6ToBuffer(ip) {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const parts = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  const buf = Buffer.alloc(16);
  parts.forEach((p, i) => buf.writeUInt16BE(parseInt(p || '0', 16), i * 2));
  return buf;
}

function startStunServer(port, host = '0.0.0.0') {
  const sock = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
  sock.on('message', (msg, rinfo) => {
    const res = buildResponse(msg, rinfo.address, rinfo.port);
    if (res) sock.send(res, rinfo.port, rinfo.address);
  });
  sock.on('error', (e) => console.error(`[stun] ${e.message}`));
  sock.bind(port, host);
  return sock;
}

module.exports = { startStunServer, buildResponse };
