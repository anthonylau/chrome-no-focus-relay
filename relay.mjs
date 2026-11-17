#!/usr/bin/env node
// CDP relay that keeps a headed Chrome from taking window focus.
//
// Sits between a CDP client (agent-browser --cdp) and Chrome's
// --remote-debugging-port and rewrites the traffic:
//   1. Target.createTarget gets background: true.
//   2. Page.bringToFront and Target.activateTarget are answered with {} and
//      never reach Chrome. HTTP /json/activate/<id> is answered the same way.
//   3. Tabs created through the relay get Emulation.setFocusEmulationEnabled
//      on every session attached to them, so hidden tabs still receive input.
//
// Usage:
//   node relay.mjs [--listen 127.0.0.1:9223] [--upstream host.docker.internal:9222]
//                  [--focus-emulation created|all|off] [--verbose]

import http from 'node:http';
import dns from 'node:dns/promises';
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return value;
}
const VERBOSE = args.includes('--verbose');
const [LISTEN_HOST, LISTEN_PORT] = splitHostPort(arg('--listen', process.env.RELAY_LISTEN ?? '127.0.0.1:9223'));
const [UPSTREAM_NAME, UPSTREAM_PORT] = splitHostPort(arg('--upstream', process.env.RELAY_UPSTREAM ?? 'host.docker.internal:9222'));
const FOCUS_EMULATION = arg('--focus-emulation', process.env.RELAY_FOCUS_EMULATION ?? 'created');
if (!['created', 'all', 'off'].includes(FOCUS_EMULATION)) {
  console.error(`--focus-emulation must be created, all or off, got ${FOCUS_EMULATION}`);
  process.exit(2);
}

// Chrome rejects DevTools HTTP and WebSocket requests whose Host header is not
// an IP address or localhost, so the relay always talks to Chrome by IPv4.
const UPSTREAM_IP = net.isIP(UPSTREAM_NAME)
  ? UPSTREAM_NAME
  : (await dns.lookup(UPSTREAM_NAME, { family: 4 })).address;
const UPSTREAM = `${UPSTREAM_IP}:${UPSTREAM_PORT}`;

// Target ids created through this relay, shared by all connections so that a
// client reattaching after a daemon restart still gets focus emulation.
const createdTargets = new Set();
// Ids for commands the relay sends on its own. Client ids are small counters.
let relayId = 2_000_000_000;

const stats = { createTarget: 0, swallowed: 0, focusEmulation: 0 };

function splitHostPort(value) {
  const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(value);
  if (!m) {
    console.error(`expected host:port, got ${value}`);
    process.exit(2);
  }
  return [m[1], Number(m[2])];
}

function log(...parts) {
  if (VERBOSE) console.log(new Date().toISOString(), ...parts);
}

// ---------- HTTP discovery (/json/version, /json/list, ...) ----------

const server = http.createServer((req, res) => {
  if (/^\/json\/activate\//.test(req.url)) {
    stats.swallowed++;
    log('swallowed HTTP', req.url);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Target activated');
    return;
  }
  const upstreamReq = http.request(
    { host: UPSTREAM_IP, port: UPSTREAM_PORT, method: req.method, path: req.url,
      headers: { ...req.headers, host: UPSTREAM } },
    (upstreamRes) => {
      const chunks = [];
      upstreamRes.on('data', (c) => chunks.push(c));
      upstreamRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        // Point advertised WebSocket URLs at the relay instead of Chrome.
        const relayHost = req.headers.host ?? `${LISTEN_HOST}:${LISTEN_PORT}`;
        body = body.split(`ws://${UPSTREAM}/`).join(`ws://${relayHost}/`)
                   .split(`ws=${UPSTREAM}/`).join(`ws=${relayHost}/`);
        const headers = { ...upstreamRes.headers };
        delete headers['content-length'];
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        res.end(body);
      });
    },
  );
  upstreamReq.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`relay: cannot reach Chrome at ${UPSTREAM}: ${e.message}`);
  });
  req.pipe(upstreamReq);
});

// ---------- WebSocket CDP traffic ----------

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (client) => bridge(client, req.url));
});

function bridge(client, path) {
  const upstream = new WebSocket(`ws://${UPSTREAM}${path}`, { perMessageDeflate: false, maxPayload: 0 });
  const queue = [];
  // Requests whose responses the relay needs to see: id -> { method, targetId }.
  const pending = new Map();
  const emulatedSessions = new Set();
  log('client connected', path);

  const toUpstream = (data) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
    else queue.push(data);
  };
  const toClient = (msg) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg));
  };

  const enableFocusEmulation = (sessionId, targetId) => {
    if (FOCUS_EMULATION === 'off' || emulatedSessions.has(sessionId)) return;
    if (FOCUS_EMULATION === 'created' && !createdTargets.has(targetId)) return;
    emulatedSessions.add(sessionId);
    stats.focusEmulation++;
    log('focus emulation on', targetId, sessionId);
    toUpstream(JSON.stringify({ id: relayId++, sessionId, method: 'Emulation.setFocusEmulationEnabled',
      params: { enabled: true } }));
  };

  client.on('message', (data, isBinary) => {
    if (isBinary) return toUpstream(data);
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return toUpstream(data); }

    if (msg.method === 'Page.bringToFront' || msg.method === 'Target.activateTarget') {
      stats.swallowed++;
      log('swallowed', msg.method, msg.sessionId ?? msg.params?.targetId ?? '');
      const reply = { id: msg.id, result: {} };
      if (msg.sessionId) reply.sessionId = msg.sessionId;
      return toClient(reply);
    }
    if (msg.method === 'Target.createTarget') {
      stats.createTarget++;
      msg.params = { ...msg.params, background: true };
      pending.set(msg.id, { method: msg.method });
      log('createTarget background', msg.params.url);
      return toUpstream(JSON.stringify(msg));
    }
    if (msg.method === 'Target.attachToTarget') {
      pending.set(msg.id, { method: msg.method, targetId: msg.params?.targetId });
    }
    toUpstream(data.toString('utf8'));
  });

  upstream.on('open', () => {
    for (const data of queue.splice(0)) upstream.send(data);
  });

  upstream.on('message', (data, isBinary) => {
    if (isBinary) return client.readyState === WebSocket.OPEN && client.send(data, { binary: true });
    const text = data.toString('utf8');
    let msg;
    try { msg = JSON.parse(text); } catch { return client.send(text); }

    // Responses to the relay's own commands never reach the client.
    if (typeof msg.id === 'number' && msg.id >= 2_000_000_000) {
      if (msg.error) log('relay command failed', JSON.stringify(msg.error));
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const req = pending.get(msg.id);
      pending.delete(msg.id);
      if (req.method === 'Target.createTarget' && msg.result?.targetId) {
        createdTargets.add(msg.result.targetId);
      }
      if (req.method === 'Target.attachToTarget' && msg.result?.sessionId) {
        enableFocusEmulation(msg.result.sessionId, req.targetId);
      }
    }
    if (msg.method === 'Target.attachedToTarget' && msg.params?.targetInfo?.type === 'page') {
      enableFocusEmulation(msg.params.sessionId, msg.params.targetInfo.targetId);
    }
    if (msg.method === 'Target.targetDestroyed') createdTargets.delete(msg.params?.targetId);
    if (client.readyState === WebSocket.OPEN) client.send(text);
  });

  const closeBoth = () => {
    if (client.readyState === WebSocket.OPEN) client.close();
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
  };
  client.on('close', () => { log('client disconnected', path); closeBoth(); });
  upstream.on('close', closeBoth);
  upstream.on('error', (e) => { console.error(`relay: upstream ${path}: ${e.message}`); closeBoth(); });
  client.on('error', closeBoth);
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`relay: ${LISTEN_HOST}:${LISTEN_PORT} is already in use. Another relay may be running, or pass --listen <host:port>.`);
  } else {
    console.error(`relay: cannot listen on ${LISTEN_HOST}:${LISTEN_PORT}: ${e.message}`);
  }
  process.exit(1);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`relay: listening on ${LISTEN_HOST}:${LISTEN_PORT}, Chrome at ${UPSTREAM} (${UPSTREAM_NAME}), focus emulation: ${FOCUS_EMULATION}`);
});

process.on('SIGUSR1', () => console.log('relay stats', JSON.stringify(stats)));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('relay stats', JSON.stringify(stats)); process.exit(0); });
}
