const UPSTREAMS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/dns-query",
  "https://dns.quad9.net/dns-query"
];

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // ===== 用户统计 API =====
    if (url.pathname === "/admin/users") {
      const email = req.headers.get("cf-access-authenticated-user-email");
      if (!email) return new Response("Unauthorized", { status: 401 });

      const list = await env.USER_KV.list({ prefix: "user:" });

      const users = await Promise.all(
        list.keys.map(k => env.USER_KV.get(k.name, "json"))
      );

      return Response.json(users);
    }

    // ===== 限制方法 =====
    if (req.method !== "POST") {
      return new Response("OK");
    }

    // ===== 鉴权 =====
    if (!(await verify(req, env))) {
      return new Response("Forbidden", { status: 403 });
    }

    // ===== 记录用户信息 =====
    const ip = req.headers.get("cf-connecting-ip");
    const ua = req.headers.get("user-agent");

    ctx.waitUntil(saveUser(ip, ua, env));

    // ===== DNS处理 =====
    const buf = new Uint8Array(await req.arrayBuffer());
    const queries = decodeBatch(buf);

    const results = await Promise.all(
      queries.map(q => resolve(q, env, ctx))
    );

    return new Response(encodeBatch(results), {
      headers: {
        "content-type": "application/octet-stream"
      }
    });
  }
};

// ===== DNS解析 =====
async function resolve(query, env, ctx) {
  const cache = caches.default;
  const key = new Request("https://cache/" + hash(query));

  const cached = await cache.match(key);
  if (cached) return new Uint8Array(await cached.arrayBuffer());

  const base64 = btoa(String.fromCharCode(...query));

  for (const upstream of UPSTREAMS) {
    try {
      const res = await fetch(`${upstream}?dns=${base64}`, {
        headers: {
          accept: "application/dns-message"
        }
      });

      if (!res.ok) continue;

      const buf = await res.arrayBuffer();

      ctx.waitUntil(
        cache.put(key, new Response(buf, {
          headers: {
            "cache-control": "max-age=300"
          }
        }))
      );

      return new Uint8Array(buf);
    } catch {}
  }

  return new Uint8Array();
}

// ===== 用户记录 =====
async function saveUser(ip, ua, env) {
  if (!ip) return;

  const key = `user:${ip}`;

  const existing = await env.USER_KV.get(key, "json");

  const data = existing || {
    ip,
    ua,
    count: 0,
    lastSeen: 0
  };

  data.count++;
  data.lastSeen = Date.now();
  data.ua = ua;

  await env.USER_KV.put(key, JSON.stringify(data), {
    expirationTtl: 86400 * 7
  });
}

// ===== 鉴权 =====
async function verify(req, env) {
  const ts = req.headers.get("x-ts");
  const token = req.headers.get("x-token");

  if (!ts || !token) return false;
  if (Math.abs(Date.now() - Number(ts)) > 30000) return false;

  const expect = await hmac(ts, env.DNS_SECRET);

  return token === expect;
}

// ===== HMAC =====
async function hmac(msg, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(msg)
  );

  return [...new Uint8Array(sig)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ===== 编解码 =====
function decodeBatch(buf) {
  let o = 0;
  const n = (buf[o] << 8) | buf[o + 1];
  o += 2;

  const out = [];

  for (let i = 0; i < n; i++) {
    const len = (buf[o] << 8) | buf[o + 1];
    o += 2;
    out.push(buf.slice(o, o + len));
    o += len;
  }

  return out;
}

function encodeBatch(list) {
  let size = 2;

  list.forEach(b => size += 2 + b.length);

  const out = new Uint8Array(size);
  let o = 0;

  out[o++] = list.length >> 8;
  out[o++] = list.length & 255;

  for (const b of list) {
    out[o++] = b.length >> 8;
    out[o++] = b.length & 255;
    out.set(b, o);
    o += b.length;
  }

  return out;
}

function hash(buf) {
  return buf.toString("hex");
}