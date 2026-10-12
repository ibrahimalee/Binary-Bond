'use strict';
const crypto = require('crypto');

// Builds the RTCIceServer list handed to each peer on join. TURN credentials
// follow the coturn "use-auth-secret" REST scheme, so they expire on their own.
function iceServersFor(config, peerId, now = Date.now()) {
  const servers = [];
  if (config.stunUrls.length) servers.push({ urls: config.stunUrls });
  if (config.turnUrls.length && config.turnSecret) {
    const username = `${Math.floor(now / 1000) + config.turnTtlSec}:${peerId}`;
    const credential = crypto.createHmac('sha1', config.turnSecret).update(username).digest('base64');
    servers.push({ urls: config.turnUrls, username, credential });
  }
  return servers;
}

const hasTurn = (config) => Boolean(config.turnUrls.length && config.turnSecret);

module.exports = { iceServersFor, hasTurn };
