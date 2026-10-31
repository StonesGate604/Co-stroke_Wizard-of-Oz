import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { FileStore } from '../server/store.js';
import { createServer } from '../server/index.js';

async function start(directory,options={}) {
  const app = await createServer({store:new FileStore(directory),...options});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  app.base=`http://127.0.0.1:${app.server.address().port}`; return app;
}
async function connect(app,session,role,clientId=randomUUID(),token=session.tokens[role]) {
  const ws = new WebSocket(app.base.replace('http:','ws:')+'/ws');
  const messages=[], waiters=[];
  ws.on('message',raw=>{const m=JSON.parse(raw);messages.push(m);for(const notify of waiters.splice(0))notify();});
  async function wait(predicate) {
    const timeout=Date.now()+5000;
    while(Date.now()<timeout) {
      const index=messages.findIndex(predicate); if(index>=0)return messages.splice(index,1)[0];
      await new Promise(resolve=>{const timer=setTimeout(resolve,30);waiters.push(()=>{clearTimeout(timer);resolve();});});
    }
    throw new Error(`No matching WebSocket message. Received: ${JSON.stringify(messages).slice(0,500)}`);
  }
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  ws.send(JSON.stringify({type:'hello',session:session.session,role,token,clientId}));
  return {ws,wait,clientId, send:m=>ws.send(JSON.stringify(m)), async op(baseRevision,type,extra={},id=randomUUID()) {
    ws.send(JSON.stringify({type:'op',op:{id,baseRevision,type,...extra}})); return {id,result:await wait(m=>m.type==='ack'&&m.id===id||m.type==='error'&&m.id===id)};
  }};
}
test('two real WebSockets: previews, turn, duplicate, conflict, refresh and process restart',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'woz-'));
  let app=await start(directory); t.after(async()=>{await app.close();});
  const session=await (await fetch(app.base+'/sessions',{method:'POST'})).json();
  const p=await connect(app,session,'participant'), w=await connect(app,session,'wizard');
  await p.wait(m=>m.type==='state'); await w.wait(m=>m.type==='state');
  const stroke={tool:'pen',points:[{x:.1,y:.1},{x:.4,y:.2}]};
  p.send({type:'preview',baseRevision:0,stroke}); assert.equal((await w.wait(m=>m.type==='preview')).stroke.author.type,'human');
  const first=await p.op(0,'stroke',{stroke}); assert.equal(first.result.type,'ack');
  const peer=await w.wait(m=>m.type==='state'&&m.state.revision===1); assert.equal(peer.state.drawing.strokes.length,1);
  assert.equal((await p.op(0,'stroke',{stroke},first.id)).result.type,'ack');
  assert.equal((await p.op(0,'clear')).result.code,'conflict');
  const request=await p.op(1,'request'); await w.wait(m=>m.type==='state'&&m.state.request);
  await w.op(2,'stroke',{stroke,requestId:request.id});
  const ai=await p.wait(m=>m.type==='state'&&m.state.revision===3); assert.equal(ai.state.drawing.strokes[1].author.type,'ai');
  await w.op(3,'finish',{requestId:request.id});
  const duplicate=await connect(app,session,'participant'); assert.equal((await duplicate.wait(m=>m.type==='error')).code,'occupied'); duplicate.ws.close();
  const refreshed=await connect(app,session,'participant',p.clientId); const snapshot=await refreshed.wait(m=>m.type==='state'); assert.equal(snapshot.state.revision,4);
  assert.equal(JSON.stringify(snapshot).includes(session.tokens.wizard),false);
  await app.close(); app=await start(directory);
  const rejoined=await connect(app,session,'participant',p.clientId); assert.equal((await rejoined.wait(m=>m.type==='state')).state.drawing.strokes.length,2);
  await rejoined.op(4,'seek',{step:1}); await rejoined.op(5,'stroke',{stroke});
  const persisted=await app.server; assert.ok(persisted);
  const recovered=new FileStore(directory); assert.equal((await recovered.read(session.session)).state.drawing.strokes.length,2);
  rejoined.ws.close(); refreshed.ws.close(); p.ws.close(); w.ws.close();
});
test('creation auth, origin restriction, private files and invalid payload',async t=>{
  const app=await start(await mkdtemp(path.join(os.tmpdir(),'woz-')),{adminToken:'test-admin'});t.after(()=>app.close());
  assert.equal((await fetch(app.base+'/sessions',{method:'POST'})).status,401);
  assert.equal((await fetch(app.base+'/health',{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(app.base+'/server/index.js')).status,404);
  assert.equal((await fetch(app.base+'/.woz-data/a.json')).status,404);
  const session=await(await fetch(app.base+'/sessions',{method:'POST',headers:{Authorization:'Bearer test-admin'}})).json();
  const bad=await connect(app,session,'wizard',randomUUID(),session.tokens.participant); assert.equal((await bad.wait(m=>m.type==='error')).code,'auth');bad.ws.close();
  const good=await connect(app,session,'participant');await good.wait(m=>m.type==='state');
  good.send('not-json'); assert.equal((await good.wait(m=>m.type==='error')).code,'invalid');good.ws.close();
});
