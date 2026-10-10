import assert from 'node:assert/strict';
import {sourcePageResponse, allowedSourceUrl, MAX_PAGE_BYTES} from '../lib/source-page.mjs';
const token = 'a'.repeat(40);
const target = 'https://mepel.pl/horus-rising-paperback-1';
const request = (body = {source:'mepel',url:target}, auth = token) => new Request('https://scanner.invalid/api/source-page', {
  method:'POST', headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:JSON.stringify(body),
});
let calls = 0;
const fetchPage = async () => {calls++;return new Response('<h1>Horus Rising</h1>', {headers:{'Content-Type':'text/html; charset=utf-8'}});};
assert.equal((await sourcePageResponse(request(), {token:'',fetchPage})).status,503);
assert.equal((await sourcePageResponse(request(undefined,'wrong'), {token,fetchPage})).status,401);
for (const url of ['http://mepel.pl/book','https://user:password@mepel.pl/book','https://mepel.pl:8080/book','https://mepel.pl.attacker.invalid/book','https://127.0.0.1/book','https://mepel.pl/admin'])
  assert.equal((await sourcePageResponse(request({source:'mepel',url}), {token,fetchPage})).status,400);
assert.equal(calls,0,'rejected requests must not access the network');
const ok = await sourcePageResponse(request(), {token,fetchPage});assert.equal(ok.status,200);assert.equal(await ok.text(),'<h1>Horus Rising</h1>');assert.equal(ok.headers.get('cache-control'),'no-store');
assert(allowedSourceUrl('osnowa','https://osnowa.pl/Raldoron_Revenant'));
assert(allowedSourceUrl('osnowa','https://osnowa.pl/pl/p/Armageddon-Season-of-Fire-HB/7295'));
assert(allowedSourceUrl('graal','https://sklep-graal.pl/pl/searchquery/Horus%20Rising/1/full/5'));
assert.equal((await sourcePageResponse(request(), {token,fetchPage:async()=>new Response(null,{status:302,headers:{Location:'https://attacker.invalid/'}})})).status,502);
assert.equal((await sourcePageResponse(request(), {token,fetchPage:async()=>new Response(null,{status:301,headers:{Location:target}})})).status,502);
assert.equal((await sourcePageResponse(request(), {token,fetchPage:async()=>new Response('blocked',{status:403})})).status,403);
assert.equal((await sourcePageResponse(request(), {token,fetchPage:async()=>new Response('pdf',{headers:{'Content-Type':'application/pdf'}})})).status,502);
assert.equal((await sourcePageResponse(request(), {token,fetchPage:async()=>new Response('x'.repeat(MAX_PAGE_BYTES+1),{headers:{'Content-Type':'text/html'}})})).status,413);
console.log('PASS: authorization, fixed source hosts/paths, redirect validation, loop detection, bounded HTML response and truthful upstream errors.');

for(const [source,url] of [
 ['poznan','https://www.antykwariat.pl/pl/searchquery/Horus/1/full/5'],
 ['nws','https://www.antykwariatnws.pl/index.php?action=antykwariat_wyszukiwarka&tekst=Horusa'],
 ['nws','https://www.antykwariatnws.pl/szukaj_w_antykwariat-Horusa---.html'],
 ['nws','https://www.antykwariatnws.pl/oferta-116-75939-title.html'],
 ['kwadryga','https://kwadryga.com/sklep/?woos=Horusa'],
 ['kwadryga','https://kwadryga.com/produkt/book/'],
 ['tania','https://www.taniaksiazka.pl/Search?q=Horusa'],
 ['tania','https://www.taniaksiazka.pl/book-p-123.html']
 ]){assert(allowedSourceUrl(source,url));assert(!allowedSourceUrl(source,url.replace(new URL(url).hostname,'evil.invalid')));assert(!allowedSourceUrl(source,new URL('/admin',url).href));assert(!allowedSourceUrl(source,new URL('/index.php?action=delete&id=1',url).href));}
console.log('PASS: four additional hosts, public search/product paths and legacy NWS redirects; account and admin URLs denied.');

for (const url of ['https://lagano.pl/?post_type=product&s=Warhammer','https://lagano.pl/page/2/?post_type=product&s=Warhammer','https://lagano.pl/ksiazki/fantastyka/warhammer-fantastyka/herezja-horusa-pretorianin-dorna/']) assert(allowedSourceUrl('lagano',url));
for (const url of ['https://lagano.pl/','https://lagano.pl/?s=book','https://lagano.pl/?post_type=product&s=book&action=delete','https://lagano.pl/wp-json/','https://lagano.pl/wp-admin/','https://evil.invalid/?post_type=product&s=book']) assert.equal(allowedSourceUrl('lagano',url),null);
console.log('PASS: Lagano public book search, pagination and product paths; arbitrary root actions denied.');
