import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { FirestoreStore } from '../server/store.js';
import { makeSession, claim, applyOperation } from '../server/session.js';

// Opt-in only: never touch a live project from the ordinary test command.
test('Firestore emulator: cross-instance listener, transactional conflict, new client recovery', {skip:!process.env.FIRESTORE_EMULATOR_HOST}, async t=>{
  const options={projectId:'co-stroke-woz-emulator',databaseId:'(default)'};
  const a=new FirestoreStore(new Firestore(options)),b=new FirestoreStore(new Firestore(options));
  const id=randomBytes(16).toString('hex');const {record}=makeSession();
  claim(record,'participant','emulator-client-123','connection');await a.update(id,()=>record);
  t.after(async()=>{await a.ref(id).delete();await a.close();await b.close();});
  const observed=new Promise((resolve,reject)=>{const unsub=b.watch(id,r=>{if(r.state.revision===1){unsub();resolve(r);}},reject);});
  const op=id=>({id,baseRevision:0,type:'stroke',stroke:{tool:'pen',points:[{x:0,y:0},{x:1,y:1}]}});
  const results=await Promise.allSettled([
    a.update(id,r=>applyOperation(r,'participant','connection',op('concurrent-one'))),
    b.update(id,r=>applyOperation(r,'participant','connection',op('concurrent-two')))
  ]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'conflict');
  assert.equal((await observed).state.drawing.strokes.length,1);
  const fresh=new FirestoreStore(new Firestore(options));
  assert.equal((await fresh.read(id)).state.revision,1);await fresh.close();
});
