// Explicit opt-in cloud verification. Creates a disposable test session.
// Credentials and expected state stay in ignored *.secret files, never stdout.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { SessionClient } from '../src/woz-client.js';

const server = process.env.WOZ_SERVER;
if (!server || new URL(server).protocol !== 'https:') throw new Error('Set WOZ_SERVER to the independent HTTPS WoZ backend.');
const phase = process.env.WOZ_PHASE || 'exercise';
const secretFile = process.env.WOZ_TEST_FILE || '.woz-cloud-test.secret';
const origin = 'https://stonesgate604.github.io';
const sockets = new Set();
const report = text => console.log(`PASS ${text}`);
const stroke = {tool:'pen',points:[{x:.15,y:.3,t:0,p:.5},{x:.5,y:.1,t:250,p:.5},{x:.8,y:.4,t:500,p:.5}]};
async function join(saved,role,base=server) {
  const ws = new WebSocket(`${base.replace(/^https:/,'wss:')}/ws`,{origin,handshakeTimeout:30000});
  sockets.add(ws);
  const messages=[], waiters=[];
  const client={ws,state:null,close:()=>ws.close()};
  ws.on('error',()=>{});
  ws.on('message',raw=>{
    const message=JSON.parse(raw);
    if(message.type==='state' && (!client.state || message.state.revision>=client.state.revision))client.state=message.state;
    messages.push(message);
    for(const notify of waiters.splice(0))notify();
  });
  client.wait=async predicate=>{
    const until=Date.now()+30000;
    while(Date.now()<until){
      const index=messages.findIndex(predicate);if(index>=0)return messages.splice(index,1)[0];
      await new Promise(resolve=>{const timer=setTimeout(resolve,100);waiters.push(()=>{clearTimeout(timer);resolve();});});
    }
    throw new Error(`Timed out waiting for ${role} message; last revision ${client.state?.revision ?? 'none'}`);
  };
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  ws.send(JSON.stringify({type:'hello',session:saved.session,role,token:saved.tokens[role],clientId:saved.clientIds[role]}));
  const hello=await client.wait(m=>m.type==='state'||m.type==='error');
  if(hello.type==='error')throw new Error(`Join failed: ${hello.code}: ${hello.message}`);
  client.op=async(type,extra={},baseRevision=client.state.revision,id=randomUUID())=>{
    const op={id,baseRevision,type,...extra};
    ws.send(JSON.stringify({type:'op',op}));
    const result=await client.wait(m=>(m.type==='ack'||m.type==='error')&&m.id===id);
    return {op,result};
  };
  client.stateAt=async revision=>{
    if(client.state.revision<revision)await client.wait(m=>m.type==='state'&&m.state.revision>=revision);
    return client.state;
  };
  return client;
}
try {
  const health=await(await fetch(`${server}/health`)).json();
  assert.equal(health.service,'co-stroke-woz');assert.equal(health.storage,'firestore');report('HTTPS service uses Firestore');
  let saved;
  if(phase==='exercise') {
    const admin=process.env.ADMIN_TOKEN || (await readFile('.woz-admin.secret','utf8')).trim();
    assert.equal((await fetch(`${server}/sessions`,{method:'POST'})).status,401);
    assert.equal((await fetch(`${server}/health`,{headers:{Origin:'https://untrusted.example'}})).status,403);
    const response=await fetch(`${server}/sessions`,{method:'POST',headers:{Authorization:`Bearer ${admin}`}});
    if(!response.ok)throw new Error(`Session creation failed: HTTP ${response.status}`);
    saved={...await response.json(),clientIds:{participant:randomUUID(),wizard:randomUUID()}};
    await writeFile(secretFile,JSON.stringify(saved));
    const p=await join(saved,'participant'),w=await join(saved,'wizard');
    p.ws.send(JSON.stringify({type:'preview',baseRevision:0,stroke}));
    assert.equal((await w.wait(m=>m.type==='preview')).stroke.author.type,'human');report('live preview through Firestore');
    const first=await p.op('stroke',{stroke});assert.equal(first.result.type,'ack');await w.stateAt(1);
    assert.equal(w.state.drawing.strokes.length,1);report('Participant stroke reaches Wizard');
    assert.equal((await p.op('stroke',{stroke},0,first.op.id)).result.type,'ack');assert.equal(p.state.revision,1);
    assert.equal((await p.op('clear',{},0)).result.code,'conflict');report('deduplication and stale edit rejection');
    const request=await p.op('request');await w.stateAt(2);assert.ok(w.state.request);
    assert.equal((await w.op('stroke',{stroke,requestId:request.op.id})).result.type,'ack');await p.stateAt(3);
    assert.equal(p.state.drawing.strokes[1].author.type,'ai');assert.equal(p.state.drawing.strokes[1].style.color,'#ff44aa');
    await w.op('finish',{requestId:request.op.id});await p.stateAt(4);assert.equal(p.state.request,null);report('AI request, enforced provenance and finish');
    await p.op('seek',{step:1});await w.stateAt(5);
    assert.equal((await w.op('stroke',{stroke,requestId:request.op.id})).result.code,'turn');
    await p.op('stroke',{stroke});assert.equal(p.state.drawing.strokes.length,2);assert.equal(p.state.drawing.strokes[1].author.type,'human');
    await p.op('undo');assert.equal(p.state.drawing.strokes.length,1);
    await p.op('clear');assert.equal(p.state.drawing.strokes.length,0);report('shared rewind, truncate, Undo, Clear and obsolete AI turn rejection');
    await p.op('stroke',{stroke});const pending=await p.op('request');await w.stateAt(10);
    await w.op('stroke',{stroke,requestId:pending.op.id});await p.stateAt(11);
    const refreshed=await join(saved,'participant');assert.deepEqual(refreshed.state.drawing,p.state.drawing);assert.deepEqual(refreshed.state.request,p.state.request);
    saved.expected=refreshed.state;await writeFile(secretFile,JSON.stringify(saved));report('role refresh restores drawing, timeline and pending request');
  } else if(phase==='timeout') {
    saved=JSON.parse(await readFile(secretFile,'utf8'));
    const memory=new Map([[`woz:${saved.session}:participant:client`,saved.clientIds.participant]]);
    globalThis.sessionStorage={getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)};
    let disconnected=false,connected=0,client;
    await new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>{client.close();reject(new Error('No automatic timeout/reconnect within 95 seconds'));},95000);
      client=new SessionClient({backend:server,session:saved.session,role:'participant',token:saved.tokens.participant,
        onStatus:status=>{if(status.startsWith('Disconnected'))disconnected=true;},
        onPreview:()=>{},onError:message=>console.log('Connection notice:',message),
        onState:state=>{
          if(!state||!client.ready)return;
          try {
            assert.equal(state.revision,saved.expected.revision);assert.deepEqual(state.drawing,saved.expected.drawing);assert.deepEqual(state.request,saved.expected.request);
            if(++connected>1&&disconnected){clearTimeout(deadline);client.close();resolve();}
          } catch(error){clearTimeout(deadline);client.close();reject(error);}
        }
      });
    });
    report('browser SessionClient automatically reconnects after Cloud Run 60-second timeout without losing state');
  } else {
    saved=JSON.parse(await readFile(secretFile,'utf8'));
    const p=await join(saved,'participant'),w=await join(saved,'wizard',process.env.WOZ_PEER_SERVER||server);
    assert.equal(p.state.revision,saved.expected.revision);assert.deepEqual(p.state.drawing,saved.expected.drawing);assert.deepEqual(p.state.request,saved.expected.request);
    assert.deepEqual(w.state.drawing,p.state.drawing);report('durable state recovered after revision/instance replacement');
    if(phase==='cross') {
      const revision=p.state.revision;
      w.ws.send(JSON.stringify({type:'preview',baseRevision:revision,stroke}));await p.wait(m=>m.type==='preview');
      await w.op('stroke',{stroke,requestId:w.state.request.id});await p.stateAt(revision+1);
      await w.op('finish',{requestId:p.state.request.id});await p.stateAt(revision+2);
      await p.op('play');await w.stateAt(revision+3);assert.deepEqual(w.state.playback,p.state.playback);
      await new Promise(resolve=>setTimeout(resolve,500));await p.op('pause');await w.stateAt(revision+4);assert.equal(w.state.step,p.state.step);
      saved.expected=p.state;await writeFile(secretFile,JSON.stringify(saved));report('different revisions synchronize previews, strokes, turns and playback');
    }
  }
} finally {
  await Promise.all([...sockets].map(ws=>new Promise(resolve=>{if(ws.readyState===WebSocket.CLOSED)return resolve();const timer=setTimeout(()=>{ws.terminate();resolve();},2000);ws.once('close',()=>{clearTimeout(timer);resolve();});ws.close();})));
}
