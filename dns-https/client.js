import dgram from "dgram";
import packet from "dns-packet";
import LRU from "lru-cache";
import crypto from "crypto";
import { request, Agent } from "undici";

// ===== ENV =====
const SERVER = process.env.DNS_SERVER;
const SECRET = process.env.DNS_SECRET;

if (!SERVER || !SECRET) {
  throw new Error("Missing env");
}

// ===== HTTP连接池 =====
const agent = new Agent({
  connections: 100,
  keepAliveTimeout: 30000
});

// ===== LRU缓存 =====
const cache = new LRU({
  max: 50000,
  ttl: 60000
});

// ===== UDP socket =====
const socket = dgram.createSocket("udp4");

// ===== 批处理队列 =====
let queue = [];
let timer = null;

// ===== 接收DNS请求 =====
socket.on("message", (msg, rinfo) => {
  const key = msg.toString("hex");

  const cached = cache.get(key);
  if (cached) {
    return socket.send(cached, rinfo.port, rinfo.address);
  }

  queue.push({ msg, rinfo, key });

  if (!timer) timer = setTimeout(flush, 5);
});

socket.bind(53);

// ===== 批量发送 =====
async function flush() {
  const batch = queue.splice(0, 200);
  timer = null;

  try {
    const body = encodeBatch(batch.map(x => x.msg));

    const res = await hedgedRequest(body);

    const decoded = decodeBatch(res);

    decoded.forEach((buf, i) => {
      const { rinfo, key } = batch[i];
      cache.set(key, buf);
      socket.send(buf, rinfo.port, rinfo.address);
    });
  } catch {
    // fallback
    batch.forEach(({ rinfo, key }) => {
      const cached = cache.get(key);
      if (cached) socket.send(cached, rinfo.port, rinfo.address);
    });
  }
}

// ===== Hedged请求 =====
async function hedgedRequest(body) {
  let done = false;

  const p1 = send(body);
  const p2 = new Promise(resolve => {
    setTimeout(() => send(body).then(resolve), 80);
  });

  return Promise.race([
    p1.then(r => { done = true; return r; }),
    p2
  ]);
}

// ===== 发送请求 =====
async function send(body) {
  const ts = Date.now().toString();
  const token = genToken(ts);

  const { body: res } = await request(SERVER, {
    method: "POST",
    dispatcher: agent,
    headers: {
      "content-type": "application/octet-stream",
      "x-ts": ts,
      "x-token": token
    },
    body
  });

  return Buffer.from(await res.arrayBuffer());
}

// ===== HMAC =====
function genToken(ts) {
  return crypto
    .createHmac("sha256", SECRET)
    .update(ts)
    .digest("hex");
}

// ===== 编码 =====
function encodeBatch(list) {
  let size = 2;
  list.forEach(b => size += 2 + b.length);

  const buf = Buffer.allocUnsafe(size);
  let o = 0;

  buf.writeUInt16BE(list.length, o); o += 2;

  for (const b of list) {
    buf.writeUInt16BE(b.length, o); o += 2;
    b.copy(buf, o);
    o += b.length;
  }

  return buf;
}

// ===== 解码 =====
function decodeBatch(buf) {
  let o = 0;
  const n = buf.readUInt16BE(o); o += 2;

  const out = [];

  for (let i = 0; i < n; i++) {
    const len = buf.readUInt16BE(o); o += 2;
    out.push(buf.slice(o, o + len));
    o += len;
  }

  return out;
}