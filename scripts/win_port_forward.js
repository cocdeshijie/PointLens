// Tiny Node TCP forwarder. Run on Windows (via WSL interop) to expose a
// localhost-bound process (Chrome's CDP) to all interfaces so WSL can reach it
// at the Windows host IP.
//
// Usage:
//   node win_port_forward.js LISTEN_PORT TARGET_PORT
//   e.g.  node win_port_forward.js 9444 9333
//
// Listens on 0.0.0.0:LISTEN_PORT, forwards every byte to 127.0.0.1:TARGET_PORT
// (and back). Half-close aware so WebSocket upgrades and long-lived CDP sockets
// stay open. Logs accept/error events to stdout so we can debug from the Linux
// side via the launching shell.

const net = require('net');

const listenPort = parseInt(process.argv[2], 10);
const targetPort = parseInt(process.argv[3], 10);
const targetHost = process.argv[4] || '127.0.0.1';

if (!listenPort || !targetPort) {
  console.error('usage: node win_port_forward.js LISTEN_PORT TARGET_PORT [TARGET_HOST]');
  process.exit(2);
}

const server = net.createServer({ allowHalfOpen: true }, (clientSocket) => {
  const upstream = net.createConnection({ host: targetHost, port: targetPort, allowHalfOpen: true }, () => {
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
  const cleanup = (who, err) => {
    if (err) console.error(`[fwd ${who} err]`, err.code || err.message);
    try { clientSocket.destroy(); } catch (_) {}
    try { upstream.destroy(); } catch (_) {}
  };
  clientSocket.on('error', (e) => cleanup('client', e));
  upstream.on('error', (e) => cleanup('upstream', e));
  clientSocket.on('end', () => upstream.end());
  upstream.on('end', () => clientSocket.end());
});

server.on('error', (e) => {
  console.error('[fwd listen err]', e.code || e.message);
  process.exit(1);
});

server.listen(listenPort, '0.0.0.0', () => {
  console.log(`forward listening 0.0.0.0:${listenPort} -> ${targetHost}:${targetPort}`);
});
