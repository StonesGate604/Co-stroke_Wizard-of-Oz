import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionClient } from '../src/woz-client.js';

test('browser reload replays one pending operation, durable receipt suppresses duplicate',()=>{
  const memory=new Map();
  globalThis.sessionStorage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
  class Socket {
    static OPEN=1;
    constructor(){this.readyState=1;this.sent=[];}
    send(m){this.sent.push(JSON.parse(m));}
    receive(m){this.onmessage({data:JSON.stringify(m)});}
    close(){this.readyState=3;this.onclose({code:1000});}
  }
  globalThis.WebSocket=Socket;
  const options={backend:'https://sync.example',session:'test',role:'participant',token:'secret',onState:()=>{},onStatus:()=>{},onPreview:()=>{},onError:()=>{}};
  const a=new SessionClient(options);a.socket.onopen();
  const snapshot={revision:0,recentOps:[]};a.socket.receive({type:'state',state:snapshot,serverNow:Date.now()});
  a.operation('stroke',{stroke:{tool:'pen',points:[]}}); const op=a.pending;
  assert.equal(a.operation('clear'),false);a.close();
  const b=new SessionClient(options);b.socket.receive({type:'state',state:snapshot,serverNow:Date.now()});
  assert.equal(b.socket.sent.filter(m=>m.type==='op').length,1);assert.equal(b.socket.sent[0].op.id,op.id);
  b.socket.receive({type:'state',state:{revision:1,recentOps:[`participant:${op.id}`]},serverNow:Date.now()});
  assert.equal(b.pending,null);b.close();
  const c=new SessionClient(options);c.socket.receive({type:'state',state:{revision:1,recentOps:[`participant:${op.id}`]},serverNow:Date.now()});
  assert.equal(c.socket.sent.length,0);c.close();
});
