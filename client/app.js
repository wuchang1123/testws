const VLESSMuxClient = require('./vless-ws-mux-client');

const client = new VLESSMuxClient({
  server: 'ws://127.0.0.1:10000',
  uuid: '11111111-1111-1111-1111-111111111111'
});

client.on('connect', ()=>console.log('✅ WS connected'));
client.on('ready', async ()=>{
  console.log('✅ VLESS MUX ready');

  // 测试 TCP
  const resp = await client.requestTCP('example.com',80,Buffer.from('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n'));
  console.log('TCP response:', resp.toString());
});

client.connect();