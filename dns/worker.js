// worker_cache_ttl.js

const VALID_UUIDS = new Set([
    "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
]);

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DEFAULT_TTL = 60;
const MAX_TTL = 300; // 防止缓存过长

export default {
    async fetch(request, env) {
        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("Expected WebSocket", { status: 400 });
        }
        const { 0: client, 1: server } = new WebSocketPair();
        handleWS(server);
        return new Response(null, { status: 101, webSocket: client });
    },
};

// ================= WebSocket =================
async function handleWS(ws) {
    ws.accept();

    ws.addEventListener("message", async (event) => {
        const data = new Uint8Array(event.data);
        let offset = 0;
        const responses = [];

        while (offset < data.length) {
            const sid = readU32(data, offset); offset += 4;
            const len = readU16(data, offset); offset += 2;
            const payload = data.slice(offset, offset + len); offset += len;

            const resp = await handleVLESS(payload);
            if (!resp) continue;

            responses.push(buildFrame(sid, resp));
        }

        if (responses.length) ws.send(concat(responses));
    });
}

// ================= VLESS =================
async function handleVLESS(payload) {
    let offset = 0;

    offset += 1; // version

    const uuidBuf = payload.slice(offset, offset + 16);
    offset += 16;
    if (!checkUUID(uuidBuf)) return null;

    const cmd = payload[offset++]; // command
    offset++; // addr type
    offset += 2;

    if (cmd !== 0x02) return null; // UDP only

    const udpLen = readU16(payload, offset);
    offset += 2;

    const dnsQuery = payload.slice(offset, offset + udpLen);

    return await handleDNS(dnsQuery);
}

// ================= DNS 处理 =================
async function handleDNS(query) {
    const key = toHex(query.slice(0, 32));
    const cacheKey = new Request("https://dns-cache/" + key);

    // 🔥 1. 查 Cache API
    let cached = await caches.default.match(cacheKey);
    if (cached) {
        return new Uint8Array(await cached.arrayBuffer());
    }

    // 🔥 2. DoH 查询
    const resp = await fetch(DOH_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/dns-message" },
        body: query
    });

    const dnsResp = new Uint8Array(await resp.arrayBuffer());

    // 🔥 3. 解析 TTL
    let ttl = parseTTL(dnsResp);
    if (!ttl || ttl <= 0) ttl = DEFAULT_TTL;
    ttl = Math.min(ttl, MAX_TTL);

    // 🔥 4. 写入 Cache API
    const response = new Response(dnsResp, {
        headers: {
            "Cache-Control": `max-age=${ttl}`
        }
    });

    await caches.default.put(cacheKey, response);

    return dnsResp;
}

// ================= TTL 解析 =================
function parseTTL(buf) {
    try {
        let offset = 12; // DNS header

        const qdcount = readU16(buf, 4);
        const ancount = readU16(buf, 6);

        // 跳过 Question
        for (let i = 0; i < qdcount; i++) {
            while (buf[offset] !== 0) {
                offset += buf[offset] + 1;
            }
            offset += 1 + 4;
        }

        let minTTL = Infinity;

        // 解析 Answer
        for (let i = 0; i < ancount; i++) {
            // 跳 name（支持压缩指针）
            if ((buf[offset] & 0xc0) === 0xc0) {
                offset += 2;
            } else {
                while (buf[offset] !== 0) {
                    offset += buf[offset] + 1;
                }
                offset += 1;
            }

            offset += 2; // type
            offset += 2; // class

            const ttl =
                (buf[offset] << 24) |
                (buf[offset + 1] << 16) |
                (buf[offset + 2] << 8) |
                buf[offset + 3];

            offset += 4;

            const rdlen = readU16(buf, offset);
            offset += 2 + rdlen;

            if (ttl > 0 && ttl < minTTL) {
                minTTL = ttl;
            }
        }

        return minTTL === Infinity ? DEFAULT_TTL : minTTL;
    } catch (e) {
        return DEFAULT_TTL;
    }
}

// ================= UUID =================
function checkUUID(buf) {
    const hex = toHex(buf);
    const uuid = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    return VALID_UUIDS.has(uuid);
}

// ================= 工具函数 =================
function readU16(b,o){return(b[o]<<8)|b[o+1];}
function readU32(b,o){return((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;}
function toHex(buf){return [...buf].map(b=>b.toString(16).padStart(2,'0')).join('');}

function buildFrame(sid,payload){
    const out = new Uint8Array(6+payload.length);
    out[0]=(sid>>24)&0xff; out[1]=(sid>>16)&0xff;
    out[2]=(sid>>8)&0xff; out[3]=sid&0xff;
    out[4]=(payload.length>>8)&0xff;
    out[5]=payload.length&0xff;
    out.set(payload,6);
    return out;
}

function concat(arr){
    let total=arr.reduce((s,a)=>s+a.length,0);
    let out=new Uint8Array(total);
    let offset=0;
    for (const a of arr) {
        out.set(a, offset);
        offset += a.length;
    }
    return out;
}