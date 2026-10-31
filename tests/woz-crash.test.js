import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

test('acknowledged stroke survives abrupt process kill and restart',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'woz-crash-'));
  const script=fileURLToPath(new URL('../server/index.js',import.meta.url));
  let child;
  async function start() {
    child=spawn(process.execPath,[script],{env:{...process.env,K_SERVICE:'',STORE:'file',PORT:'0',DATA_DIR:directory},stdio:['ignore','pipe','pipe']});
    const port=await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(new Error('Startup timeout')),5000);
      child.stdout.on('data',data=>{output+=data;const match=output.match(/listening on (\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Server exited ${code}`));});
    });
    return `http://127.0.0.1:${port}`;
  }
  t.after(()=>child?.kill('SIGKILL'));
  let base=await start();
  const session=await(await fetch(base+'/sessions',{method:'POST'})).json();
  async function join() {
    const ws=new WebSocket(base.replace('http:','ws:')+'/ws');
    await once(ws,'open');const first=once(ws,'message');
    ws.send(JSON.stringify({type:'hello',session:session.session,role:'participant',token:session.tokens.participant,clientId:'stable-client-crash'}));
    return {ws,state:JSON.parse((await first)[0]).state};
  }
  const original=await join();
  const ack=new Promise(resolve=>original.ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='ack')resolve(m);}));
  original.ws.send(JSON.stringify({type:'op',op:{id:'crash-stroke-123',baseRevision:0,type:'stroke',stroke:{tool:'pen',points:[{x:0,y:0},{x:1,y:1}]}}}));
  await ack;const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  base=await start();const recovered=await join();
  assert.equal(recovered.state.revision,1);assert.equal(recovered.state.drawing.strokes.length,1);
  assert.ok(recovered.state.recentOps.includes('participant:crash-stroke-123'));
  recovered.ws.close();original.ws.close();
});
