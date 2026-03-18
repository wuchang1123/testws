// vless-wss-mux-server.js
const fs = require('fs');
const https = require('https');
const WebSocket = require('ws');
const net = require('net');
const dgram = require('dgram');

const USERS = new Set(['11111111111111111111111111111111']);
const AUTH_TOKEN = 'secret-token'; // 伪 Reality 校验

const server = https.createServer({
  cert: fs.readFileSync('./cert.pem'),
  key: fs.readFileSync('./key.pem')
});

const wss = new WebSocket.Server({ server });

function parseUUID(buf){ return buf.toString('hex'); }

function parseAddress(buf, offset){
  const type = buf[offset++]; let host, port;
  if(type===0x01){ host=Array.from(buf.slice(offset,offset+4)).join('.'); offset+=4;}
  else if(type===0x02){ const len=buf[offset++]; host=buf.slice(offset,offset+len).toString(); offset+=len;}
  port = buf.readUInt16BE(offset); offset+=2;
  return {host,port,offset};
}

wss.on('connection',(ws,req)=>{
  // 🧠 简单伪装校验（类似 Reality 思路）
  if(req.headers['x-auth-token'] !== AUTH_TOKEN){
    ws.close(); return;
  }

  const conn = {
    stage:0,
    streams:new Map(),
    udpSessions:new Map(),
    lastActive: Date.now()
  };

  ws.on('message',msg=>{
    conn.lastActive = Date.now();
    const data = Buffer.from(msg);

    try{
      if(conn.stage===0){
        let offset=0;
        if(data[offset++]!==0x00) return ws.close();

        const uuid = parseUUID(data.slice(offset,offset+16)); offset+=16;
        if(!USERS.has(uuid)) return ws.close();

        const optLen=data[offset++]; offset+=optLen;
        const cmd=data[offset++];

        const {host,port} = parseAddress(data,offset);

        ws.send(Buffer.from([0x00,0x00])); // VLESS response
        conn.stage=1;
        return;
      }

      // === MUX ===
      let offset=0;
      while(offset+4<=data.length){
        const sid=data.readUInt16BE(offset); offset+=2;
        const len=data.readUInt16BE(offset); offset+=2;
        const payload=data.slice(offset,offset+len); offset+=len;

        // TCP
        if(!conn.streams.has(sid)){
          const sock = net.connect(80,'example.com'); // demo,可改host
          sock.on('data',d=>{
            const buf = Buffer.concat([
              Buffer.from([sid>>8,sid&0xff]),
              Buffer.from([d.length>>8,d.length&0xff]),
              d
            ]);
            ws.send(buf);
          });
          sock.on('close',()=>conn.streams.delete(sid));
          conn.streams.set(sid,sock);
        }
        conn.streams.get(sid).write(payload);
      }

    }catch(e){ ws.close(); }
  });

  // 心跳检测
  const interval = setInterval(()=>{
    if(Date.now()-conn.lastActive>30000){
      ws.close();
    }
  },10000);

  ws.on('close',()=>{
    clearInterval(interval);
    conn.streams.forEach(s=>s.destroy());
  });
});

server.listen(443,()=>console.log('🚀 WSS VLESS MUX server :443'));