// dns_vless_client.js
const dgram = require('dgram');
const net = require('net');
const WebSocket = require('ws');
const packet = require('dns-packet');

// ================= 配置 =================
const LOCAL_UDP_PORT = 5353;
const LOCAL_TCP_PORT = 5354;
const WS_URL = 'wss://your-worker.your-domain.workers.dev';
const CACHE_MAX = 1000; // 本地缓存最大条目数
const CACHE_TTL = 60;   // 本地缓存默认TTL秒

// ================= LRU 本地缓存 =================
class LRUCache {
    constructor(max) {
        this.max = max;
        this.cache = new Map();
    }
    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        if (Date.now() > item.expire) { 
            this.cache.delete(key); 
            return null;
        }
        this.cache.delete(key);
        this.cache.set(key, item);
        return item.value;
    }
    set(key, value, ttl = CACHE_TTL) {
        if (this.cache.size >= this.max) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, { value, expire: Date.now() + ttl * 1000 });
    }
}

const dnsCache = new LRUCache(CACHE_MAX);

// ================= UDP Server =================
const udp = dgram.createSocket('udp4');

// WebSocket MUX
let streamId = 1;
const pending = new Map();
const ws = new WebSocket(WS_URL);

ws.on('open', () => console.log('WS connected to Worker'));
ws.on('message', (data) => {
    let offset = 0;
    while (offset < data.length) {
        const sid = data.readUInt32BE(offset); offset += 4;
        const len = data.readUInt16BE(offset); offset += 2;
        const payload = data.slice(offset, offset + len); offset += len;

        const ctx = pending.get(sid);
        if (!ctx) continue;

        // 写入本地缓存
        dnsCache.set(ctx.key, payload, CACHE_TTL);

        // 发送回客户端
        udp.send(payload, ctx.port, ctx.address);
        pending.delete(sid);
    }
});

// ================= 辅助函数 =================
function buildVLESSHeader() {
    const buf = Buffer.alloc(20);
    buf[0] = 0x00; // version
    return buf;
}
function buildFrame(sid, payload) {
    const out = Buffer.alloc(6 + payload.length);
    out.writeUInt32BE(sid, 0);
    out.writeUInt16BE(payload.length, 4);
    out.set(payload, 6);
    return out;
}
function hashKey(msg) {
    return msg.slice(0, 32).toString('hex');
}

// ================= UDP 收到请求 =================
udp.on('message', (msg, rinfo) => {
    const key = hashKey(msg);
    const cached = dnsCache.get(key);
    if (cached) {
        udp.send(cached, rinfo.port, rinfo.address);
        return;
    }

    const sid = streamId++;
    pending.set(sid, { address: rinfo.address, port: rinfo.port, key });

    const udpLen = Buffer.alloc(2);
    udpLen.writeUInt16BE(msg.length);
    const vless = Buffer.concat([buildVLESSHeader(), udpLen, msg]);
    const frame = buildFrame(sid, vless);

    ws.send(frame);
});

udp.bind(LOCAL_UDP_PORT, () => console.log(`DNS UDP running on ${LOCAL_UDP_PORT}`));

// ================= TCP 支持（可选大包DNS） =================
const tcp = net.createServer((socket) => {
    socket.on('data', (data) => {
        const key = hashKey(data);
        const cached = dnsCache.get(key);
        if (cached) {
            const lenBuf = Buffer.alloc(2);
            lenBuf.writeUInt16BE(cached.length);
            socket.write(Buffer.concat([lenBuf, cached]));
            return;
        }

        const sid = streamId++;
        pending.set(sid, { address: null, port: null, socket, key });

        const udpLen = Buffer.alloc(2);
        udpLen.writeUInt16BE(data.length);
        const vless = Buffer.concat([buildVLESSHeader(), udpLen, data]);
        const frame = buildFrame(sid, vless);
        ws.send(frame);
    });
});

tcp.listen(LOCAL_TCP_PORT, () => console.log(`DNS TCP running on ${LOCAL_TCP_PORT}`));