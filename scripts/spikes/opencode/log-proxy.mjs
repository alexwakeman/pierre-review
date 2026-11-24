// A CONNECT proxy that logs every target host and chains to the upstream proxy ($UPSTREAM, http://host:port).
// Usage: UPSTREAM=... PROXY_LOG=... node log-proxy.mjs <port>
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

const up = new URL(process.env.UPSTREAM);
const log = (m) => fs.appendFileSync(process.env.PROXY_LOG, `${new Date().toISOString()} ${m}\n`);
const server = http.createServer((req, res) => { log(`HTTP ${req.method} ${req.url}`); res.writeHead(403); res.end(); });
server.on('connect', (req, client, head) => {
  log(`CONNECT ${req.url}`);
  const upstream = net.connect(Number(up.port), up.hostname, () => {
    const auth = up.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(up.username)}:${decodeURIComponent(up.password)}`).toString('base64')}\r\n` : '';
    upstream.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n${auth}\r\n`);
    upstream.once('data', (chunk) => {
      client.write(chunk);
      if (head?.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
  });
  upstream.on('error', (e) => { log(`ERR ${req.url} ${e.message}`); client.destroy(); });
  client.on('error', () => upstream.destroy());
});
server.listen(Number(process.argv[2]), '127.0.0.1', () => log('listening'));
