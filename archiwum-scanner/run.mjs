import {queueFingerprint,continuationPlan,dispatchContinuation} from './continuation.mjs';
import {scanBook,SCANNER_VERSION} from './runtime/scanner.mjs';
import {setTimeout as wait} from 'node:timers/promises';

const origin='https://warhammer-archiwum-kolekcji.karnol13.chatgpt.site';
const endpoint=origin+'/api/github-scan';
// Neither an imported adapter nor a future parser may silently use Vercel.
const network=globalThis.fetch;
globalThis.fetch=(input,options)=>{
 const url=new URL(input instanceof Request?input.url:String(input));
 if(url.hostname==='vercel.app'||url.hostname.endsWith('.vercel.app'))throw Error('Vercel transport disabled');
 return network(input,options);
};
let identity;
async function token(){
 if(identity&&identity.until>Date.now()+60_000)return identity.value;
 const url=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,secret=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
 if(!url||!secret)throw Error('Run this scanner in GitHub Actions with id-token: write');
 const target=new URL(url);target.searchParams.set('audience',endpoint);
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
   if(!response.ok){const details=await response.json().catch(()=>({}));const error=Object.assign(new Error('Site '+body.action+' HTTP '+response.status+(typeof details.code==='string'?' '+details.code:'')),{status:response.status});throw error;}
   return await response.json();
  }catch(error){if(attempt>=retries||error.status&&error.status<500)throw error;await wait(3000*(attempt+1));}
 }
}
function policy(){let next=0;return {async beforeRead(signal){await wait(Math.max(0,next-Date.now()),undefined,{signal});next=Date.now()+2000;},async onFailure(){}};}
async function scan(task){
 if(task.scannerVersion!==SCANNER_VERSION)throw Error('Scanner revision mismatch; update the public scanner');
 const result=await scanBook(task.book,task.cooldowns,task.scope,task.sources,{source:35000,book:45000,vinted:35000,concurrency:8},undefined,policy(),{'Amazon PL':policy()});
 // Result validation follows the task order, while parsers schedule slow shops first.
 result.sources=task.sources.map(name=>result.sources.find(s=>s.source===name));return result;
}
async function main(){
 const probe=process.argv.includes('--probe');
 if(probe){
  const book={id:'probe',title:'Horus Rising',pl:'Wywyższenie Horusa',series:'HORUS HERESY',number:1,raw:'',uncertain:false,note:'',kind:'powieść'};
  const report=await scan({book,cooldowns:{},scope:'all',sources:['Copernicus','Tantis','Vinted','Allegro Lokalnie'],scannerVersion:SCANNER_VERSION});
  for(const source of report.sources)console.log(JSON.stringify({source:source.source,state:source.state,httpStatus:source.httpStatus,offers:report.offers.filter(o=>o.source===source.source).length}));
  return;
 }
 const status=await api({action:'status'});if(!status||status.changed)throw Error('Scanner access not confirmed');
 if(!status.queue||status.queue.paused||status.queue.done>=status.queue.total){console.log('No unfinished active queue. Nothing to scan.');return;}
 const generation=Number(process.env.ARCHIWUM_CONTINUATION||0),expectedFingerprint=process.env.ARCHIWUM_QUEUE_FINGERPRINT||'';
 if(!Number.isInteger(generation)||generation<0||generation>100)throw Error('Invalid continuation generation');
 if(generation>0&&(!expectedFingerprint||expectedFingerprint!==queueFingerprint(status.queue?.token))){console.log('Queue ended or was replaced; continuation stopped.');return;}
 let initialQueueToken=status.queue?.token;

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
 const until=Date.now()+(process.env.GITHUB_EVENT_NAME==='push'?60_000:12*60_000);
 try{
  while(!stopping&&Date.now()<until){
   const next=await api({action:'next',queueToken:initialQueueToken});if(next.complete||next.state==='paused'){console.log(JSON.stringify({queueEnd:{state:next.state,done:next.done,total:next.total,message:next.message}}));break;}if(next.changed){if(next.reason==='REPLACED')break;console.log(JSON.stringify({waiting:next.reason}));await wait(Math.min(10,Math.max(1,next.retryAfter||5))*1000);continue;}
   if(!next.task)continue;
   if(!initialQueueToken)initialQueueToken=next.task.taskId.split(':')[0]; // A saved checkpoint was recovered server-side.
   const result=await scan(next.task);
   const saved=await api({action:'result',queueToken:initialQueueToken,taskId:next.task.taskId,scan:result});
   if(!saved.changed)stages++;
   // Public logs contain counts and source health, never books or personal data.
   console.log(JSON.stringify({stage:stages,sources:result.sources.map(s=>({source:s.source,state:s.state,httpStatus:s.httpStatus})),done:saved.done,total:saved.total,complete:saved.complete,changed:saved.changed}));
   if(saved.complete)break;
   await wait(1000);
  }
 }catch(error){failed=true;throw error;}finally{await api({action:'release',failed}).catch(()=>console.error('Lease will expire automatically.'));}
 const persisted=await api({action:'status'});
 const progress=persisted.worker?.result?JSON.parse(persisted.worker.result):null;
 console.log(JSON.stringify({persisted:{state:persisted.worker?.state,done:progress?.done,total:progress?.total,sourceProgress:progress?.sourceProgress},savedStages:stages}));
 if(!stopping){const plan=continuationPlan(initialQueueToken,persisted,stages,generation);if(plan){await dispatchContinuation(plan,process.env.GITHUB_TOKEN);console.log('Next bounded scan run requested for the same unfinished queue.');}}

}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
