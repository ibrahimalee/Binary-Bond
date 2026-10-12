'use strict';
const { createServer } = require('./app');
const { loadConfig } = require('./config');
const { startStunServer } = require('./stun');

const config = loadConfig();
const bb = createServer({ config });

bb.server.listen(config.port, config.host, () => {
  console.log(`BinaryBond listening on http://localhost:${config.port}`);
  if (!config.adminToken) console.log('  admin console disabled (set BB_ADMIN_TOKEN to enable /admin)');
  if (!config.persist) console.log('  ephemeral mode: tenants and usage are not written to disk');
});

let stun = null;
if (config.stunPort) {
  stun = startStunServer(config.stunPort);
  console.log(`  built-in STUN responder on udp/${config.stunPort}`);
}

let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`${sig} received, shutting down`);
  stun?.close();
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  await bb.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
