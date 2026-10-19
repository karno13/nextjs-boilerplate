import {createHash} from 'node:crypto';
export const queueFingerprint=token=>typeof token==='string'&&token?createHash('sha256').update(token).digest('hex'):'';
export function continuationPlan(initialToken,status,stages,generation,waitingForRetry=false){
 const queue=status?.queue;
 if(!initialToken||queue?.token!==initialToken||queue.paused||!Number.isInteger(stages)||(stages<1&&!waitingForRetry)||status.worker?.state!=='yielded'||!Number.isInteger(generation)||generation<0||generation>=100||!Number.isInteger(queue.done)||!Number.isInteger(queue.total)||queue.done>=queue.total)return null;
 return {ref:'main',inputs:{continuation:String(generation+1),queue_fingerprint:queueFingerprint(initialToken)}};
}
// A replacement is a separately saved owner plan. Start a new bounded job for
// its fingerprint; never let an old task save into the replacement queue.
export function replacementPlan(initialToken,status,generation){
 const q=status?.queue;
 if(!initialToken||!q?.token||initialToken===q.token||q.paused||q.done>=q.total||!['yielded','complete'].includes(status.worker?.state)||!Number.isInteger(generation)||generation<0||generation>=100)return null;
 return {ref:'main',inputs:{continuation:String(generation+1),queue_fingerprint:queueFingerprint(q.token)}};
}
export async function dispatchContinuation(plan,token,request=fetch){
 if(!plan)return false;
 if(typeof token!=='string'||!token)throw Error('Missing workflow continuation credential');
 const response=await request('https://api.github.com/repos/karno13/nextjs-boilerplate/actions/workflows/warcraft-scan.yml/dispatches',{method:'POST',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},body:JSON.stringify(plan),signal:AbortSignal.timeout(20000),redirect:'error'});
 if(!response.ok)throw Error('Workflow continuation HTTP '+response.status);
 await response.body?.cancel();return true;
}
