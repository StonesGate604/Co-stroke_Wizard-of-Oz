import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession, claim, applyOperation, authenticate, visibleStep, LEASE_MS } from '../server/session.js';
const stroke = { tool:'pen', points:[{x:.1,y:.2},{x:.3,y:.4}] };
function setup() {
  const {record,tokens} = makeSession();
  claim(record,'participant','participant-client','p',1000); claim(record,'wizard','wizard-client','w',1000);
  let n = 0;
  return {record,tokens,op(role,type,extra={},at=1100) {
    return applyOperation(record,role,role === 'wizard' ? 'w' : 'p',{id:`operation-${++n}`,baseRevision:record.state.revision,type,...extra},at);
  }};
}
test('human → request → Wizard AI stroke → finish, provenance is enforced',()=>{
  const s = setup(); s.op('participant','stroke',{stroke}); s.op('participant','request');
  const requestId = s.record.state.request.id;
  s.op('wizard','stroke',{stroke:{...stroke,author:{type:'human'}},requestId}); s.op('wizard','finish',{requestId});
  assert.equal(s.record.state.drawing.strokes[1].author.type,'ai');
  assert.equal(s.record.state.drawing.strokes[1].style.color,'#ff44aa');
  assert.equal(s.record.state.step,2); assert.equal(s.record.state.request,null);
});
test('rewind truncates future; stale operations fail; duplicates do not append twice',()=>{
  const s=setup(); s.op('participant','stroke',{stroke}); s.op('participant','stroke',{stroke});
  s.op('participant','seek',{step:1}); s.op('participant','stroke',{stroke});
  assert.equal(s.record.state.drawing.strokes.length,2);
  const id=s.record.state.recentOps.at(-1).split(':')[1];
  applyOperation(s.record,'participant','p',{id,baseRevision:0,type:'stroke',stroke},1200);
  assert.equal(s.record.state.revision,4);
  assert.throws(()=>applyOperation(s.record,'participant','p',{id:'stale-op-123',baseRevision:0,type:'clear'},1200),{code:'conflict'});
});
test('seek cancels pending AI, delayed Wizard stroke cannot change revised history',()=>{
  const s=setup(); s.op('participant','request'); const requestId=s.record.state.request.id;
  s.op('participant','seek',{step:0});
  assert.throws(()=>s.op('wizard','stroke',{stroke,requestId}),{code:'turn'});
});
test('server anchored playback survives reconnect and pauses at correct step',()=>{
  const s=setup(); for(let i=0;i<4;i++)s.op('participant','stroke',{stroke});
  s.op('participant','play',{},2000);
  assert.equal(visibleStep(s.record.state,2850),2);
  s.op('participant','pause',{},2850); assert.equal(s.record.state.step,2); assert.equal(s.record.state.playback,null);
});
test('role token, lease ownership, expiry and invalid geometry',()=>{
  const s=setup(); assert.throws(()=>authenticate(s.record,'wizard',s.tokens.participant),{code:'auth'});
  assert.throws(()=>claim(s.record,'participant','different-client','x',1200),{code:'occupied'});
  assert.throws(()=>s.op('wizard','stroke',{stroke}),{code:'turn'});
  assert.throws(()=>s.op('participant','stroke',{stroke:{tool:'pen',points:[{x:Infinity,y:0},{x:0,y:0}]}}),{code:'invalid'});
  assert.throws(()=>s.op('participant','request',{},1000+LEASE_MS),{code:'replaced'});
});
