#!/usr/bin/env node
// TCP proxy for the sync tests, in its own process (the tests call git with spawnSync, which
// would block an in-process proxy). Prints `{"port":N}` once listening, then reads commands on
// stdin, one per line, answering `ok <cmd>`:
//   target <port>     forward to 127.0.0.1:<port>
//   cut               drop every live connection and reset new ones (network loss)
//   restore           let traffic through again
//   throttle <B/s>    slow the client->server direction (0 = off)

import { createServer, connect } from "node:net";
import { createInterface } from "node:readline";

let target = Number(process.argv[2]);
let cut = false;
let throttle = 0;
const sockets = new Set();

const server = createServer((client) => {
  if (cut) {
    client.resetAndDestroy();
    return;
  }
  const upstream = connect(target, "127.0.0.1");
  sockets.add(client);
  sockets.add(upstream);
  const done = () => {
    sockets.delete(client);
    sockets.delete(upstream);
    client.destroy();
    upstream.destroy();
  };
  client.on("error", done);
  upstream.on("error", done);
  client.on("close", done);
  upstream.on("close", done);
  upstream.pipe(client);
  client.on("data", (chunk) => {
    if (!throttle) {
      if (!upstream.write(chunk)) client.pause();
      return;
    }
    client.pause();
    upstream.write(chunk);
    setTimeout(() => client.resume(), Math.ceil((chunk.length / throttle) * 1000));
  });
  client.on("end", () => upstream.end());
  upstream.on("drain", () => {
    if (!throttle) client.resume();
  });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});

createInterface({ input: process.stdin }).on("line", (line) => {
  const [cmd, arg] = line.trim().split(/\s+/);
  if (cmd === "target") target = Number(arg);
  else if (cmd === "cut") {
    cut = true;
    for (const s of sockets) s.destroy();
    sockets.clear();
  } else if (cmd === "restore") cut = false;
  else if (cmd === "throttle") throttle = Number(arg) || 0;
  process.stdout.write(`ok ${cmd}\n`);
}).on("close", () => process.exit(0));
