import test from 'node:test';
import assert from 'node:assert/strict';
import { handleServersAPI } from '../src/handlers/dashboard.js';
import { handleWebSocketUpgrade } from '../src/handlers/update.js';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';
import { clearAllCaches } from '../src/utils/cache.js';
import { clearDashboardLatencyHistoryCache } from '../src/database/schema.js';
import { generateToken } from '../src/middleware/auth.js';
import { SITE_FIELDS } from '../src/utils/settings.js';
import { acceptsSample, latestReportSample, mergeInventoryState, mergePendingSamples } from '../src/frontend/utils/stateOrder.js';

globalThis.WebSocketRequestResponsePair = class {};
const now=1700000000000;
const sample=(ts,cpu=1,reportTs=ts)=>({ts,data:{cpu,net_tx_monthly:cpu},reportTs});
const site={...Object.fromEntries(SITE_FIELDS.map(k=>[k,''])),jwt_secret:'x'.repeat(32),is_public:'false',turnstile_enabled:'false'};
const inventory=[{id:'visible-1',name:'Visible',history_partition_id:1,is_hidden:'0',timestamp:now},{id:'hidden-1',name:'Hidden',history_partition_id:2,is_hidden:'1',timestamp:now}];
function db(){return {prepare(sql){return {bind(){return this},async first(){return sql.includes("key = 'site_options'")?{value:JSON.stringify(site)}:null},async all(){return {results:sql.includes('SELECT * FROM servers ORDER BY')?inventory.map(s=>({...s})):[]}},async run(){throw Error('unexpected write')}}},async batch(statements){return statements.map(()=>({results:[],success:true}))}}}

test('deferred homepage is authenticated and does not wait on realtime; default API still reads realtime',async()=>{
 clearAllCaches();clearDashboardLatencyHistoryCache();let calls=0;
 const env={API_SECRET:'synthetic-only',DB:db(),METRICS_BROADCASTER:{idFromName:()=> 'global',get:()=>({fetch:async()=>{calls++;return Response.json({updates:[]})}})}};
 const token=await generateToken(env,site);
 const request=(query='',auth=true)=>new Request('https://example.com/api/servers'+query,{headers:auth?{Authorization:'Bearer '+token}:{}});
 const denied=await handleServersAPI(request('?realtime=deferred',false),env,site);assert.equal(denied.status,401);assert.equal(calls,0);
 const deferred=await handleServersAPI(request('?realtime=deferred'),env,site);assert.equal(deferred.status,200);assert.equal(calls,0);
 const body=await deferred.json();assert.equal(body.servers.length,2);assert.deepEqual(body.latestReportUpdates,[]);
 const ordinary=await handleServersAPI(request(),env,site);assert.equal(ordinary.status,200);assert.equal(calls,1);
 clearAllCaches();clearDashboardLatencyHistoryCache();
});

test('snapshot WebSocket allowlist is trusted, visibility filtered and never copied from client headers',async()=>{
 site.is_public='true';clearAllCaches();let forwarded;
 const env={API_SECRET:'synthetic-only',DB:db(),METRICS_BROADCASTER:{idFromName:()=> 'global',get:()=>({fetch:async request=>{forwarded=request;return {status:101}}})}};
 const req=(url,headers={})=>new Request(url,{headers:{Upgrade:'websocket','X-CFSM-Snapshot-Ids':'["hidden-1"]',...headers}});
 assert.equal((await handleWebSocketUpgrade(req('https://example.com/api/ws?snapshot=1'),env)).status,101);
 assert.deepEqual(JSON.parse(forwarded.headers.get('X-CFSM-Snapshot-Ids')),['visible-1']);
 await handleWebSocketUpgrade(req('https://example.com/api/ws'),env);assert.equal(forwarded.headers.get('X-CFSM-Snapshot-Ids'),null);
 const token=await generateToken(env,site);
 await handleWebSocketUpgrade(req('https://example.com/api/ws?snapshot=1',{Authorization:'Bearer '+token}),env);
 assert.deepEqual(JSON.parse(forwarded.headers.get('X-CFSM-Snapshot-Ids')),['visible-1','hidden-1']);
 site.is_public='false';clearAllCaches();assert.equal((await handleWebSocketUpgrade(req('https://example.com/api/ws?snapshot=1'),env)).status,401);clearAllCaches();
});

function broadcaster(storage, sockets=[]){return new MetricsBroadcaster({setWebSocketAutoResponse(){},getWebSockets:()=>sockets,storage},{});}
test('latest bootstrap sample survives a new DO instance, preserves masking, rejects stale writes and expires',async(t)=>{
 t.mock.method(Date,'now',()=>now);const persisted=new Map();
 const storage={async get(k){return structuredClone(persisted.get(k))},async put(k,v){persisted.set(k,structuredClone(v))}};
 const first=broadcaster(storage);
 await Promise.all([
  first._persistFrontendSnapshots([{serverId:'visible-1',samples:[{ts:now-10,data:{cpu:10,ip_v4:'203.0.113.1'}},{ts:now,data:{cpu:20,net_tx_monthly:100,ip_v4:'203.0.113.1'}}]}],now),
  first._persistFrontendSnapshots([{serverId:'visible-1',samples:[{ts:now-100,data:{cpu:99}}]}],now-100)
 ]);
 await first._persistFrontendSnapshots([{serverId:'visible-1',samples:[{ts:now,data:{cpu:99}}]}],now-1);
 const second=broadcaster(storage);const messages=[];const ws={send:v=>messages.push(JSON.parse(v))};
 await second._sendInitialSnapshot(ws,['visible-1','missing-1']);
 assert.equal(messages[0].type,'snapshot');assert.equal(messages[0].updates.length,1);assert.equal(messages[0].updates[0].samples.length,1);
 assert.equal(messages[0].updates[0].samples[0].data.cpu,20);assert.equal(messages[0].updates[0].samples[0].data.ip_v4,'1');assert.deepEqual(messages[0].missingIds,['missing-1']);
 t.mock.method(Date,'now',()=>now+301000);messages.length=0;await second._sendInitialSnapshot(ws,['visible-1']);assert.equal(messages[0].updates.length,0);
});

test('snapshot subscribers cannot widen trusted scopes or arbitrary ID lists',async()=>{
 let attachment={scope:'all',serverIds:['visible-1'],snapshotServerIds:['visible-1']},closed=false;
 const ws={deserializeAttachment:()=>attachment,serializeAttachment:a=>{attachment=a},send(){},close(){closed=true}};
 const actor=broadcaster({async get(){},async put(){}},[ws]);actor._hintAgentRealtimeIntervals=async()=>{};
 await actor.webSocketMessage(ws,JSON.stringify({type:'subscribe',scope:'all',ids:['visible-1','hidden-1']}));assert.deepEqual(attachment.serverIds,['visible-1']);
 await actor.webSocketMessage(ws,JSON.stringify({type:'subscribe',scope:'hidden-1',ids:[]}));assert.equal(closed,true);
 const refused=await actor.fetch(new Request('http://internal/ws?subscribe=hidden-1',{headers:{Upgrade:'websocket','X-CFSM-Snapshot-Ids':'["visible-1"]'}}));
 assert.equal(refused.status,403);
});

test('bootstrap storage stays bounded and storage failure does not reject ingestion',async(t)=>{
 t.mock.method(Date,'now',()=>now);let stored;
 const actor=broadcaster({async get(){return null},async put(_key,value){stored=structuredClone(value)}});
 await actor._persistFrontendSnapshots([{serverId:'kept-1',samples:[{ts:now,data:{cpu:2}}]}],now);
 await actor._persistFrontendSnapshots([{serverId:'visible-1',samples:[{ts:now,data:{cpu:1,padding:'x'.repeat(70000)}}]}],now);
 assert.ok(new TextEncoder().encode(JSON.stringify(stored)).length<=64*1024);
 assert.equal(stored.updates[0].serverId,'kept-1');
 const failed=broadcaster({async get(){return null},async put(){throw Error('synthetic storage unavailable')}});
 await assert.doesNotReject(failed._persistFrontendSnapshots([{serverId:'visible-1',samples:[{ts:now,data:{cpu:1}}]}],now));
});

test('sample ordering rejects older snapshots/REST and permits genuinely newer monthly resets',()=>{
 const current={sample_timestamp:now,report_timestamp:now+10};
 assert.equal(acceptsSample(current,now-1,now+100),false);assert.equal(acceptsSample(current,now,now+9),false);assert.equal(acceptsSample(current,now,now+11),true);
 const live={ts:now,reportTs:now+10,data:{cpu:50,net_tx_monthly:1000}};
 const old={name:'Current metadata',traffic_limit:500,timestamp:now-100,last_updated:now-90,cpu:1,net_tx_monthly:1};
 const kept=mergeInventoryState(old,live);assert.equal(kept.cpu,50);assert.equal(kept.name,'Current metadata');assert.equal(kept.traffic_limit,500);assert.equal(kept.net_tx_monthly,1000);
 const reset={...old,timestamp:now+100,last_updated:now+100,net_tx_monthly:0};assert.equal(mergeInventoryState(reset,live).net_tx_monthly,0);
 const delayed=mergeInventoryState({...old,name:'New metadata'},null,{...old,timestamp:now,last_updated:now,net_tx_monthly:1000});
 assert.equal(delayed.net_tx_monthly,1000);assert.equal(delayed.name,'New metadata');
 const latest=latestReportSample({reportTs:now+10,samples:[{ts:now,data:{cpu:50}},{ts:now-100,data:{cpu:10}}]});assert.equal(latest.ts,now);assert.equal(latest.data.cpu,50);
 const pending=mergePendingSamples([sample(now+200,20)], [sample(now+100,10),sample(now+200,9,now-1)],now);
 assert.deepEqual(pending.map(s=>s.ts),[now+100,now+200]);assert.equal(pending[1].data.cpu,20);
});
