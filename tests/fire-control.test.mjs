import test from 'node:test';
import assert from 'node:assert/strict';
import {createHoldFire,fireInterval} from '../src/fire-control.js';

test('short tap fires on release while a held burst never adds a release shot',()=>{
 const hold=createHoldFire();let shots=0;const fire=()=>{shots++;return true;};
 hold.begin(0);assert.equal(hold.tick(100,95,fire),false);assert.equal(hold.release(),true);assert.equal(shots,0);
 hold.begin(200);assert.equal(hold.tick(389,95,fire),false);assert.equal(hold.tick(390,95,fire),true);
 assert.equal(hold.tick(400,95,fire),false);assert.equal(hold.tick(485,95,fire),true);assert.equal(hold.release(),false);assert.equal(shots,2);
});
test('cancel, blur and modal cancellation cannot resume a burst or release a shot',()=>{
 const hold=createHoldFire();hold.begin(0);hold.cancel();assert.equal(hold.tick(1000,95,()=>true),false);assert.equal(hold.release(),false);
 hold.begin(1000);hold.tick(1190,95,()=>true);hold.cancel();assert.equal(hold.tick(4000,95,()=>true),false);
});
test('a late frame emits one shot and blocked capacity retries without queued catch-up',()=>{
 const hold=createHoldFire();let shots=0;hold.begin(0,{immediate:true});
 assert.equal(hold.tick(0,95,()=>false),false);assert.equal(hold.tick(34,95,()=>true),false);
 assert.equal(hold.tick(35,95,()=>{shots++;return true}),true);
 assert.equal(hold.tick(9000,95,()=>{shots++;return true}),true);assert.equal(shots,2);
 assert.equal(hold.tick(9001,95,()=>true),false);assert.equal(hold.release(),false);
});
test('empty ammunition can cancel from inside the accepted shot',()=>{
 const hold=createHoldFire();hold.begin(0);hold.tick(190,95,()=>{hold.cancel();return true;});
 assert.equal(hold.active,false);assert.equal(hold.release(),false);assert.equal(hold.tick(500,95,()=>true),false);
 assert.ok(fireInterval('corn')<fireInterval('bun'));assert.ok(fireInterval('burgerbomb')>fireInterval('bun'));
});
