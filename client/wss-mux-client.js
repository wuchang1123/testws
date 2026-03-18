// vless-wss-mux-client.js
const WebSocket = require('ws');
const EventEmitter = require('events');

class Client extends EventEmitter{
  constructor(opt){
    super();
    this.server = opt.server;
    this.uuid = opt.uuid.replace(/-/g,'');
    this.token = opt.token;
    this.ws=null;
    this.stage=0;
    this.streams=new Map();
    this.sid=1;
  }

  connect(){
    this.ws = new WebSocket(this.server,{
      rejectUnauthorized:false,
      headers:{'x-auth-token':this.token}
    });

    this.ws.on('open',()=>{
      this.stage=0;
      this._handshake();
      this.emit('connect');
    });

    this.ws.on('message',d=>this._handle(d));
    this.ws.on('close',()=>setTimeout(()=>this.connect(),3000));

    // 心跳
    setInterval(()=>{
      if(this.ws.readyState===1){
        this.ws.ping();
      }
    },10000);
  }

  _handshake(){
    const buf = Buffer.alloc(1+16+1+1+1+1+11+2);
    let o=0;
    buf[o++]=0x00;
    Buffer.from(this.uuid,'hex').copy(buf,o); o+=16;
    buf[o++]=0x00;
    buf[o++]=0x01;
    buf[o++]=0x02;
    const host="example.com";
    buf[o++]=host.length;
    buf.write(host,o); o+=host.length;
    buf.writeUInt16BE(80,o);
    this.ws.send(buf);
  }

  _handle(data){
    if(this.stage===0){ this.stage=1; this.emit('ready'); return; }

    let offset=0;
    while(offset+4<=data.length){
      const sid=data.readUInt16BE(offset); offset+=2;
      const len=data.readUInt16BE(offset); offset+=2;
      const payload=data.slice(offset,offset+len); offset+=len;

      if(this.streams.has(sid)){
        this.streams.get(sid)(payload);
      }
    }
  }

  sendFrame(sid,payload){
    const buf = Buffer.concat([
      Buffer.from([sid>>8,sid&0xff]),
      Buffer.from([payload.length>>8,payload.length&0xff]),
      payload
    ]);
    this.ws.send(buf);
  }

  requestTCP(host,port,data){
    const sid=this.sid++;
    return new Promise(res=>{
      this.streams.set(sid,d=>{res(d); this.streams.delete(sid);});
      this.sendFrame(sid,data);
    });
  }
}

module.exports=Client;