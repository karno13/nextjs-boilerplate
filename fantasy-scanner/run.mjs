import {scanBook,SCANNER_VERSION} from './runtime/scanner.mjs';
import {setTimeout as wait} from 'node:timers/promises';

// Only identical public shop pages are reused, for at most two minutes.
// The bounded cache is local to this run; identity/API calls never enter it.
export function createStoreFetch(network,{now=Date.now,ttl=120_000,maxBytes=16*1024*1024,maxPage=2*1024*1024}={}){
 const pages=new Map();let bytes=0;const stats={hits:0,reads:0};
 const remove=key=>{const entry=pages.get(key);if(entry){bytes-=entry.body.byteLength;pages.delete(key);}};
 const remember=async(response,key,started,lifetime)=>{
  const reader=response.body?.getReader();if(!reader)return;
  const chunks=[];let length=0;
  try{
   while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>maxPage||length>maxBytes){void reader.cancel().catch(()=>{});return;}chunks.push(value);}
   if(started+lifetime<=now())return;
   const body=new Uint8Array(length);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
   if(/captcha|verify you are human|Access Denied|Just a moment\.\.\.|cf-chl-/i.test(new TextDecoder().decode(body.slice(0,100000))))return;
   for(const [key,entry] of pages)if(entry.until<=now())remove(key);
   remove(key);while(bytes+length>maxBytes||pages.size>=64){const oldest=pages.keys().next().value;if(oldest===undefined)break;remove(oldest);}
   const headers=new Headers(response.headers);headers.delete('content-encoding');headers.delete('content-length');
   pages.set(key,{body,headers:[...headers],until:started+lifetime});bytes+=length;
  }catch{void reader.cancel().catch(()=>{});}
 };
 const read=async(input,options={})=>{
  const url=new URL(input instanceof Request?input.url:String(input)),headers=new Headers(options.headers);
  const eligible=!(input instanceof Request)&&url.protocol==='https:'&&!url.username&&!url.password
   &&(options.method||'GET').toUpperCase()==='GET'&&!headers.has('authorization')&&!headers.has('cookie')
   &&/text\/html/i.test(headers.get('accept')||'')&&/^ArchiwumFantasy\//.test(headers.get('user-agent')||'')
   &&!/^(?:.*\.)?(?:vinted\.pl|amazon\.[a-z.]+)$/.test(url.hostname)&&options.cache!=='no-store';
  options.signal?.throwIfAborted();
  if(!eligible)return network(input,options);
  const key=JSON.stringify([url.href,[...headers].sort()]),entry=pages.get(key);
  if(entry&&entry.until>now()){stats.hits++;return new Response(entry.body.slice(),{status:200,headers:entry.headers});}
  remove(key);stats.reads++;const started=now(),response=await network(input,options);
  const control=response.headers.get('cache-control')||'';
  if(response.status===200&&!response.headers.has('set-cookie')&&!/no-store|no-cache|private/i.test(control)
   &&!/\bmax-age\s*=\s*0\b/i.test(control)&&response.headers.get('vary')!=='*'&&/text\/html|application\/json/i.test(response.headers.get('content-type')||'')){
   // Consume the clone in the background; the parser reads its original stream.
   const maxAge=control.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i);
   const lifetime=maxAge?Math.min(ttl,Math.max(0,Number(maxAge[1])-Number(response.headers.get('age')||0))*1000):ttl;
   void remember(response.clone(),key,started,lifetime);
  }
  return response;
 };
 read.stats=stats;return read;
}

const audience='https://warhammer-fantasy-archiwum.karnol13.chatgpt.site/api/github-scan';
const endpoint='https://warhammer-archiwum-kolekcji.karnol13.chatgpt.site/api/fantasy-scan-bridge';
// Neither an imported adapter nor a future parser may silently use Vercel.
const network=globalThis.fetch;
const cachedStoreFetch=createStoreFetch(network);
globalThis.fetch=(input,options)=>{
 const url=new URL(input instanceof Request?input.url:String(input));
 if(url.hostname==='vercel.app'||url.hostname.endsWith('.vercel.app'))throw Error('Vercel transport disabled');
 return cachedStoreFetch(input,options);
};
let identity;
async function token(){
 if(identity&&identity.until>Date.now()+60_000)return identity.value;
 const url=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,secret=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
 if(!url||!secret)throw Error('Run this scanner in GitHub Actions with id-token: write');
 const target=new URL(url);target.searchParams.set('audience',audience);
 if(target.protocol!=='https:'||!target.hostname.endsWith('.actions.githubusercontent.com'))throw Error('Invalid GitHub identity endpoint');
 const response=await fetch(target,{headers:{Authorization:'Bearer '+secret},signal:AbortSignal.timeout(20_000),redirect:'error'});
 if(!response.ok)throw Error('GitHub identity unavailable');
 const body=await response.json();if(typeof body.value!=='string')throw Error('Missing identity');
 // Mask the token before any later error can include it.
 console.log('::add-mask::'+body.value);
 const claims=JSON.parse(Buffer.from(body.value.split('.')[1],'base64url').toString('utf8'));
 console.log(JSON.stringify({identity:{issuer:claims.iss,audience:claims.aud,repositoryId:claims.repository_id,ownerId:claims.repository_owner_id,workflow:claims.workflow_ref,ref:claims.ref,event:claims.event_name,subject:claims.sub,visibility:claims.repository_visibility,issued:claims.iat,notBefore:claims.nbf,expires:claims.exp}}));
 identity={value:body.value,until:claims.exp*1000};return identity.value;
}
async function api(body,retries=3){
 for(let attempt=0;;attempt++){
  try{
   const response=await fetch(endpoint,{method:'POST',headers:{'X-Archiwum-GitHub-Token':await token(),'Content-Type':'application/json'},body:JSON.stringify({...body,identityToken:await token()}),signal:AbortSignal.timeout(70_000),redirect:'error'});
   if(response.status===409){const details=await response.json().catch(()=>({}));return {changed:true,reason:details.code||'QUEUE_CHANGED',retryAfter:Number(response.headers.get('Retry-After')||5)};}
   if(!response.ok){const details=await response.json().catch(()=>({}));const error=Object.assign(new Error('Site HTTP '+response.status+(typeof details.code==='string'?' '+details.code:'')),{status:response.status});throw error;}
   return await response.json();
  }catch(error){if(attempt>=retries||error.status&&error.status<500)throw error;await wait(3000*(attempt+1));}
 }
}
function policy(){let next=0;return {async beforeRead(signal){await wait(Math.max(0,next-Date.now()),undefined,{signal});next=Date.now()+2000;},async onFailure(){}};}
async function scan(task){
 if(task.scannerVersion!==SCANNER_VERSION)throw Error('Scanner revision mismatch; update the public scanner');
 return scanBook(task.book,task.cooldowns,task.scope,task.sources,{source:35000,book:45000,vinted:35000,concurrency:8},undefined,policy(),{'Amazon PL':policy()});
}
async function main(){
 const probe=process.argv.includes('--probe');
 if(probe){
  const book={id:'probe',title:'Trollslayer',pl:'Zabójca Trolli',author:'William King',series:'Gotrek i Felix',number:1,raw:'',uncertain:false,note:'',kind:'powieść'};
  const report=await scan({book,cooldowns:{},scope:'all',sources:['Copernicus','Tantis','Tezeusz','Allegro Lokalnie'],scannerVersion:SCANNER_VERSION});
  for(const source of report.sources)console.log(JSON.stringify({source:source.source,state:source.state,httpStatus:source.httpStatus,offers:report.offers.filter(o=>o.source===source.source).length}));
  return;
 }
 const status=await api({action:'status'});if(!status||status.changed)throw Error('Scanner access not confirmed');
 const keyResponse=await fetch('https://token.actions.githubusercontent.com/.well-known/jwks',{signal:AbortSignal.timeout(20_000),redirect:'error'});
 if(!keyResponse.ok)throw Error('GitHub public signing keys unavailable');
 const freshKeys=await keyResponse.json();
 const keySaved=await api({action:'refresh-keys',keys:freshKeys.keys});if(!keySaved.ok)throw Error('Public signing keys were not saved');
 console.log('Public signing-key refresh confirmed by Sites.');
 console.log(JSON.stringify({before:{state:status.worker?.state,done:status.queue?.done,total:status.queue?.total,hasWorkerResult:!!status.worker?.result}}));
 const claim=await api({action:'claim'});if(!claim.claimed){console.log('Another run is active or the completed scan is cooling down.');return;}
 let failed=false,stopping=false,stages=0;
 process.once('SIGTERM',()=>{stopping=true;});process.once('SIGINT',()=>{stopping=true;});
 // A bounded job resumes the durable queue at the next scheduled invocation.
 const until=Date.now()+45*60_000;
 try{
  while(!stopping&&Date.now()<until){
   const next=await api({action:'next',sourceBatchSize:8});if(next.complete){console.log(JSON.stringify({queueEnd:{state:next.state,done:next.done,total:next.total,message:next.message}}));break;}if(next.changed){if(next.reason==='REPLACED')break;console.log(JSON.stringify({waiting:next.reason}));await wait(Math.min(10,Math.max(1,next.retryAfter||5))*1000);continue;}
   if(!next.task)continue; // A saved checkpoint was recovered server-side.
   const result=await scan(next.task);
   const saved=await api({action:'result',sourceBatchSize:8,taskId:next.task.taskId,scan:result});
   if(!saved.changed)stages++;
   // Public logs contain counts and source health, never books or personal data.
   console.log(JSON.stringify({stage:stages,sources:result.sources.map(s=>({source:s.source,state:s.state,httpStatus:s.httpStatus,durationMs:s.durationMs,requestCount:s.requestCount})),done:saved.done,total:saved.total,complete:saved.complete,changed:saved.changed,httpCache:{...cachedStoreFetch.stats}}));
   if(saved.complete)break;
  }
 }catch(error){failed=true;throw error;}finally{await api({action:'release',failed}).catch(()=>console.error('Lease will expire automatically.'));}
 const persisted=await api({action:'status'});
 const progress=persisted.worker?.result?JSON.parse(persisted.worker.result):null;
 console.log(JSON.stringify({persisted:{state:persisted.worker?.state,done:progress?.done,total:progress?.total,sourceProgress:progress?.sourceProgress},savedStages:stages}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
