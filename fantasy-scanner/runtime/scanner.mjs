//#region lib/public-antiquarian-request.ts
function isPodkarpackiSearch(url) {
	const u = new URL(url);
	return u.origin === "https://www.antykwariatpodkarpacki.pl" && u.pathname === "/szukaj.php" && !!u.searchParams.get("fraza");
}
async function fetchPublicAntiquarianPage(url, init) {
	if (!isPodkarpackiSearch(url)) return fetch(url, init);
	const u = new URL(url), query = u.searchParams.get("fraza"), page = u.searchParams.get("strona") || "1";
	if (query.length > 500 || !/^\d{1,3}$/.test(page) || Number(page) < 1) throw Error("Nieprawidłowe zapytanie antykwariatu.");
	const headers = new Headers(init.headers);
	headers.set("Content-Type", "application/x-www-form-urlencoded");
	const response = await fetch(u.origin + "/szukaj.php", {
		...init,
		headers,
		method: "POST",
		body: new URLSearchParams({ fraza: query }),
		redirect: "manual"
	});
	if (![302, 303].includes(response.status)) return response;
	const destination = new URL(response.headers.get("location") || "", u.origin);
	const session = response.headers.get("set-cookie")?.match(/(?:^|,\s*)PHPSESSID=([A-Za-z0-9,-]{1,128})(?:;|$)/)?.[1];
	await response.body?.cancel();
	if (destination.origin !== u.origin || destination.pathname !== "/wyniki" || !session) throw Error("Nie potwierdzono publicznej sesji wyszukiwarki antykwariatu.");
	destination.searchParams.set("strona", page);
	headers.delete("Content-Type");
	headers.set("Cookie", "PHPSESSID=" + session);
	return fetch(destination.href, {
		...init,
		headers,
		redirect: "manual"
	});
}
function normalizePublicAntiquarianSearch(html, url) {
	if (!isPodkarpackiSearch(url)) return html;
	if (/Brak produktów w wybranej kategorii/.test(html)) return html.replace(/<ul\b[^>]*id=["']pager["'][^>]*>[\s\S]*?<\/ul>/gi, "");
	return html.replace(/href=["']https:\/\/www\.antykwariatpodkarpacki\.pl\/wyniki\?strona=(\d+)["']/gi, (_, page) => {
		const next = new URL(url);
		next.searchParams.set("strona", page);
		return "href=\"" + next.href.replace(/&/g, "&amp;") + "\"" + (Number(page) === Number(new URL(url).searchParams.get("strona") || 1) + 1 ? " rel=\"next\"" : "");
	});
}
var isHermesEmptyCandidate = (url, status) => {
	const u = new URL(url);
	return status === 404 && u.origin === "https://hermeszaczytany.pl" && u.pathname === "/q/" && !!u.searchParams.get("keywords");
};
var isHermesEmptyPage = (html) => /Niestety nie znaleziono produktu!/.test(html) && /RC_HOST_PATH\s*=\s*["']https:\/\/hermeszaczytany\.pl\//.test(html);
//#endregion
//#region lib/allegro-lokalnie.ts
function parseAllegroListing(html, book, checked) {
	const products = [];
	let listing = false;
	const visit = (node) => {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			node.forEach(visit);
			return;
		}
		const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
		if (types.includes("ItemList")) listing = true;
		if (types.some((type) => ["Product", "Book"].includes(type))) products.push(node);
		for (const key of [
			"@graph",
			"itemListElement",
			"item"
		]) visit(node[key]);
	};
	for (const script of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) try {
		visit(JSON.parse(script[1]));
	} catch {}
	const empty = /class=["'][^"']*mlc-no-offers-to-show/.test(html);
	if (!products.length && !listing && !empty) throw Error("Nie potwierdzono danych ofert w odpowiedzi źródła. Sprawdź wyszukiwanie ręcznie.");
	const offers = [];
	for (const product of products) for (const data of Array.isArray(product.offers) ? product.offers : [product.offers]) {
		if (!data || data["@type"] === "AggregateOffer" || data.priceCurrency !== "PLN") continue;
		let url;
		try {
			url = new URL(data.url || product.url);
		} catch {
			continue;
		}
		if (url.protocol !== "https:" || url.hostname !== "allegrolokalnie.pl" || url.port || url.username || url.password || !/^\/oferta\/[^/]+$/.test(url.pathname)) continue;
		const condition = /UsedCondition/.test(data.itemCondition || product.itemCondition || "") ? "used" : /NewCondition/.test(data.itemCondition || product.itemCondition || "") ? "new" : "unknown";
		const offer = baseOffer(book, clean(product.name || ""), url.href, "Allegro Lokalnie", Number(data.price), "PLN", condition, checked, true);
		if (!offer) continue;
		const availability = String(data.availability || "");
		offer.available = /InStock|LimitedAvailability/.test(availability);
		offer.availabilityKnown = /InStock|LimitedAvailability|OutOfStock|Discontinued|SoldOut/.test(availability);
		offer.image = typeof product.image === "string" ? product.image : product.image?.url || null;
		offers.push(offer);
	}
	return [...new Map(offers.map((offer) => [offer.url, offer])).values()];
}
async function allegroOffers(book, checked, read) {
	const queries = [...new Set([book.pl, book.title].filter(Boolean))];
	const results = await Promise.all(queries.map(async (query) => {
		try {
			return { offers: parseAllegroListing(await read("https://allegrolokalnie.pl/oferty/q/" + encodeURIComponent(query)), book, checked) };
		} catch (error) {
			return {
				offers: [],
				error
			};
		}
	}));
	const failures = results.filter((r) => r.error);
	if (failures.length === queries.length) throw failures[0].error;
	return {
		offers: [...new Map(results.flatMap((r) => r.offers).map((o) => [o.url, o])).values()],
		partial: failures.length > 0,
		coverage: `Sprawdzono ${queries.length - failures.length}/${queries.length} wyszukiwań tytułu PL/EN.`
	};
}
//#endregion
//#region lib/source-candidates.ts
var polishAntiquarianCandidates = [
	{
		key: "kroliczajama",
		name: "Antykwariat Królicza Jama",
		url: "https://kroliczajama.pl/",
		language: "PL",
		englishFirst: false,
		mixed: true,
		polishAntiquarian: true,
		automatic: true,
		evidence: "https://kroliczajama.pl/13926-david-ferring-o-warhammer-konrad",
		evidenceNote: "Potwierdzono kartę „Warhammer. Konrad” i opis stanu egzemplarza. Karta produktu nie potwierdza bieżącej dostępności."
	},
	{
		key: "hermeszaczytany",
		name: "Hermes Zaczytany",
		url: "https://hermeszaczytany.pl/",
		language: "PL",
		englishFirst: false,
		mixed: true,
		polishAntiquarian: true,
		automatic: true,
		evidence: "https://hermeszaczytany.pl/25-science-fiction-fantasy-horror-pl",
		evidenceNote: "Potwierdzono dział fantastyki w antykwariacie. Nie potwierdzono konkretnej karty Warhammera."
	},
	{
		key: "grochowski",
		name: "Antykwariat Grochowski",
		url: "https://agrochowski.pl/",
		language: "PL",
		englishFirst: false,
		mixed: true,
		polishAntiquarian: true,
		automatic: true,
		evidence: "https://agrochowski.pl/pl/c/Fantasy%2C-science-fiction/421/89",
		evidenceNote: "Potwierdzono katalog fantasy i science fiction. Nie potwierdzono konkretnej karty Warhammera."
	},
	{
		key: "tomik",
		name: "Antykwariat Tomik",
		url: "https://antykwariattomik.pl/",
		language: "PL",
		englishFirst: false,
		mixed: true,
		polishAntiquarian: true,
		automatic: true,
		evidence: "https://antykwariattomik.pl/pl/c/Ksiazki/38",
		evidenceNote: "Potwierdzono własny sklep i katalog książek. Warhammer pozostaje tropem do sprawdzenia."
	},
	{
		key: "zakladka",
		name: "Antykwariat Zakładka",
		url: "https://antykwariat-zakladka.pl/",
		language: "PL",
		englishFirst: false,
		mixed: true,
		polishAntiquarian: true,
		automatic: true,
		evidence: "https://antykwariat-zakladka.pl/sklep/",
		evidenceNote: "Potwierdzono własny sklep warszawskiego antykwariatu. Nie potwierdzono konkretnej karty Warhammera."
	},
	{
		key: "podkarpacki",
		name: "Antykwariat Podkarpacki",
		url: "https://www.antykwariatpodkarpacki.pl/",
		language: "PL",
		englishFirst: false,
		mixed: true,
		polishAntiquarian: true,
		automatic: true,
		evidence: "https://www.antykwariatpodkarpacki.pl/sklep-internetowy/literatura/fantastyka/fantasy",
		evidenceNote: "Potwierdzono osobny dział fantasy. Nie potwierdzono konkretnej karty Warhammera."
	},
	{
		key: "poliart",
		name: "Antykwariat Poliart",
		url: "https://poliart.biz/",
		language: "PL",
		englishFirst: false,
		mixed: true,
		polishAntiquarian: true,
		automatic: true,
		evidence: "https://poliart.biz/ksiazki-czasopisma-kartografia-i-nuty/157526-500-zagadek-z-fantastyki-i-science-fiction.html",
		evidenceNote: "Potwierdzono polski antykwariat, książki z opisem stanu i dział fantastyki. Nie potwierdzono konkretnej karty Warhammera."
	}
];
var sourceCandidates = [
	...polishAntiquarianCandidates,
	{
		key: "bonito",
		name: "Bonito",
		url: "https://bonito.pl/",
		language: "PL / EN",
		englishFirst: false,
		mixed: false,
		evidence: "https://bonito.pl/produkt/brama-z-kosci-ognisty-brzask-tom-2"
	},
	{
		key: "swiatksiazki",
		name: "Świat Książki",
		url: "https://www.swiatksiazki.pl/",
		language: "PL / EN",
		englishFirst: false,
		mixed: false,
		evidence: "https://www.swiatksiazki.pl/the-sundering-7641687-ksiazka.html"
	},
	{
		key: "libristo",
		name: "Libristo",
		url: "https://www.libristo.pl/",
		language: "EN i inne",
		englishFirst: true,
		mixed: false,
		evidence: "https://www.libristo.pl/pl/ksiazka/realmslayer_48132954"
	},
	{
		key: "travellingman",
		name: "Travelling Man",
		url: "https://travellingman.com/",
		language: "EN",
		englishFirst: true,
		mixed: false,
		evidence: "https://travellingman.com/collections/novels/products/gotrek-and-felix-the-first-omnibus"
	},
	{
		key: "elementgames",
		name: "Element Games",
		url: "https://elementgames.co.uk/",
		language: "EN",
		englishFirst: true,
		mixed: false,
		evidence: "https://elementgames.co.uk/wargames-and-miniatures-by-manufacturer/games-workshop/BlackLibrary"
	},
	{
		key: "abebooks",
		name: "AbeBooks",
		url: "https://www.abebooks.com/",
		language: "EN i inne",
		englishFirst: true,
		mixed: true,
		evidence: "https://www.abebooks.com/9781844163915/Orcslayer-Warhammer-Gotrek-Felix-Long-1844163911/plp"
	},
	{
		key: "biblio",
		name: "Biblio",
		url: "https://www.biblio.com/",
		language: "EN i inne",
		englishFirst: true,
		mixed: true,
		evidence: "https://www.biblio.com/book/orcslayer-gotrek-felix-nathan-long/d/1474881170"
	},
	{
		key: "awesomebooks",
		name: "AwesomeBooks",
		url: "https://www.awesomebooks.com/",
		language: "EN",
		englishFirst: true,
		mixed: true,
		evidence: "https://www.awesomebooks.com/book/9781841541020/skavenslayer-gotrek-felix-warhammer-novel-2/used"
	},
	{
		key: "nobleknight",
		name: "Noble Knight Games",
		url: "https://www.nobleknight.com/",
		language: "EN",
		englishFirst: true,
		mixed: true,
		evidence: "https://www.nobleknight.com/P/2147735724/Gotrek-and-Felix-First-Omnibus"
	}
];
function candidateSearchUrl(book, shop) {
	const title = shop.englishFirst ? book.title : book.pl || book.title;
	return "https://www.google.com/search?q=" + encodeURIComponent("site:" + new URL(shop.url).hostname + " " + title + (shop.polishAntiquarian ? " książka" : " Warhammer book książka"));
}
//#endregion
//#region lib/source-access.ts
var manualSourceDetails = {
	...Object.fromEntries(sourceCandidates.filter((shop) => !shop.automatic).map((shop) => [shop.name, {
		url: candidateSearchUrl({
			title: "Warhammer",
			pl: null
		}, shop),
		reason: (shop.evidenceNote ? shop.evidenceNote + " " : "") + "Nowe źródło do oceny — automatyczny odczyt cen i dostępności nie został jeszcze zweryfikowany.",
		alternative: shop.polishAntiquarian ? "Szukaj polskiego tytułu z karty książki. Sprawdź opis stanu, kompletność i dostępność konkretnego egzemplarza; potwierdzoną ofertę dodaj ręcznie." : "Wyszukaj tytuł z karty książki. Sprawdź język, papierowe wydanie, stan egzemplarza i dostawę do Polski; potwierdzoną ofertę dodaj ręcznie."
	}])),
	"Vinted": {
		url: "https://www.vinted.pl/catalog?search_text=Warhammer",
		reason: "Na czas testów Vinted jest wyłączone z automatycznego skanu.",
		alternative: "Wyszukuj ręcznie po tytule. Skaner skupia się na pozostałych serwisach, księgarniach i antykwariatach."
	},
	"Pierwodruk": {
		url: "https://antykwariatpierwodruk.pl/sklep/",
		reason: "Sklep i wyszukiwarka zwracają HTTP 500 podczas weryfikacji 10.10.2026.",
		alternative: "Otwórz sklep i sprawdź ofertę ręcznie. Automatyczny odczyt wymaga przywrócenia działania strony."
	},
	"Mepel": {
		url: "https://mepel.pl/ksiazki",
		reason: "Odczyt strony produktu jest blokowany również z alternatywnego serwera Vercel (HTTP 403).",
		alternative: "Wyszukaj tytuł w sklepie i dodaj konkretną ofertę ręcznie. Poprzednie oferty pozostają w historii."
	},
	"ERLI": {
		url: "https://erli.pl/kategoria?phrase=Warhammer",
		reason: "Wyszukiwanie jest dostępne, ale sprawdzone strony produktów blokują odczyt (HTTP 403).",
		alternative: "Wyszukaj tytuł i dodaj cenę konkretnego produktu ręcznie. Sama wyszukiwarka nie potwierdza stanu ani dostępności."
	},
	"SkupSzop": {
		url: "https://skupszop.pl/",
		reason: "Nie potwierdzono działającego czytnika wyników i cen produktów.",
		alternative: "Sprawdź egzemplarz w sklepie i dodaj ofertę ręcznie; „jak nowa” oznacza książkę używaną."
	},
	"Allegro": {
		url: "https://allegro.pl/listing?string=Warhammer+książka",
		reason: "Brak działającego publicznego odczytu cen w tym skanerze.",
		alternative: "Wyszukaj tytuł i dodaj ofertę ręcznie. Allegro Lokalnie ma osobny skaner."
	},
	"Warhammer.com": {
		url: "https://www.warhammer.com/en-PL/black-library-lp",
		reason: "Nie zweryfikowano czytnika papierowych książek, cen i dostępności z dynamicznego katalogu.",
		alternative: "Otwórz dział Black Library. Publiczne dane strony istnieją, ale wymagają osobnego, zweryfikowanego czytnika."
	},
	"Czytam.pl": {
		url: "https://czytam.pl/szukaj?q=Warhammer",
		reason: "Wyniki i część danych produktu są uzupełniane przez JavaScript; pełnego odczytu nie potwierdzono.",
		alternative: "Wyszukaj tytuł w sklepie i dodaj ofertę ręcznie; dostępna cena w kodzie strony nie wystarcza do potwierdzenia dostępności."
	},
	"Antykwariat Evos": {
		url: "https://antykwariatevos.pl/",
		reason: "Brak zweryfikowanego czytnika wyszukiwarki i danych egzemplarza.",
		alternative: "Publiczna wyszukiwarka sklepu jest dostępna; aktualną cenę i stan sprawdź ręcznie."
	},
	"Toruński Antykwariat Księgarski": {
		url: "https://antykwariat-torun.pl/",
		reason: "Brak zweryfikowanego czytnika wyszukiwarki i danych egzemplarza.",
		alternative: "Użyj wyszukiwarki sklepu i dodaj konkretną ofertę ręcznie."
	},
	"Antykwariat Warszawa": {
		url: "https://antykwariatwaw.pl/",
		reason: "Brak zweryfikowanego czytnika cen i dostępności.",
		alternative: "Użyj wyszukiwarki sklepu. Link do wyszukiwania tytułu jest też w szczegółach książki."
	},
	"Antykwariat Gelber": {
		url: "https://antykwariat-gelber.pl/pl/shop/search/1/?search=Warhammer",
		reason: "Nie potwierdzono pełnego automatycznego odczytu danych egzemplarza.",
		alternative: "Sklep udostępnia publiczny formularz wyszukiwania; dodaj cenę i stan ręcznie."
	},
	"Antykwariat Hobbit": {
		url: "https://antykwariathobbit.pl/?post_type=product&s=Warhammer",
		reason: "Nie potwierdzono działającego czytnika ofert i stanu egzemplarza.",
		alternative: "Wyszukiwanie produktów jest dostępne; odczyt ceny i dostępności wymaga dalszej weryfikacji."
	},
	"Ceneo": {
		url: "https://www.ceneo.pl/;szukaj-warhammer",
		reason: "Źródło informacyjne; nie jest objęte automatycznym skanem.",
		alternative: "Porównaj sklepy i sprawdź cenę w sklepie docelowym."
	},
	"World of Books": {
		url: "https://www.worldofbooks.com/en-gb/search?text=Warhammer",
		reason: "Przygotowany link do wyszukiwania; brak zweryfikowanego czytnika.",
		alternative: "Sprawdź wydanie, stan i dostawę do Polski, następnie dodaj ofertę ręcznie."
	}
};
var isManualScanSource = (name) => Object.hasOwn(manualSourceDetails, name);
//#endregion
//#region lib/vinted-policy.ts
function vintedFailure(status, header = null, now = Date.now(), captcha = false) {
	const code = captcha ? "CAPTCHA" : status === 429 ? "HTTP_429" : status === 403 ? "HTTP_403" : "HTTP_" + status;
	const fallback = 3e4;
	const seconds = header?.trim() && /^\d+$/.test(header.trim()) ? Number(header) * 1e3 : NaN;
	const parsed = Number.isFinite(seconds) ? now + seconds : header ? Date.parse(header) : NaN;
	const until = Number.isFinite(parsed) ? Math.max(now + fallback, parsed) : now + fallback;
	const reason = captcha ? "Vinted wymaga CAPTCHA." : status === 429 ? "Vinted ograniczył liczbę zapytań (HTTP 429)." : status === 403 ? "Vinted odmówił dostępu (HTTP 403)." : `Vinted zwrócił błąd HTTP ${status}.`;
	return Object.assign(new Error(reason), {
		code,
		retryAfter: new Date(until).toISOString(),
		errorOrigin: "source",
		httpStatus: status
	});
}
function waitVinted(ms, signal) {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const stop = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", stop);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", stop);
			resolve();
		}, Math.max(0, ms));
		signal.addEventListener("abort", stop, { once: true });
	});
}
//#endregion
//#region lib/request-deadline.ts
/** Bounds the entire operation, including body reads. Parent abort stays distinct from timeout. */
async function withDeadline(operation, ms, message, parent) {
	const controller = new AbortController();
	let timer;
	let onAbort = () => {};
	const stopped = new Promise((_, reject) => {
		onAbort = () => {
			const reason = parent?.reason || new DOMException("Anulowano", "AbortError");
			controller.abort(reason);
			reject(reason);
		};
		if (parent?.aborted) {
			onAbort();
			return;
		}
		parent?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => {
			const error = new Error(message);
			error.name = "TimeoutError";
			controller.abort(error);
			reject(error);
		}, ms);
	});
	try {
		return await Promise.race([stopped, Promise.resolve().then(() => {
			controller.signal.throwIfAborted();
			return operation(controller.signal);
		})]);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
		parent?.removeEventListener("abort", onAbort);
	}
}
var decode = (s) => s.replace(/&amp;|&#38;/g, "&").replace(/&quot;/g, "\"");
var attr$2 = (tag, name) => decode(tag.match(new RegExp("\\b" + name + "=[\"\\']([^\"\\']*)[\"\\']", "i"))?.[1] || "");
function safeNext(raw, current) {
	try {
		const base = new URL(current), u = new URL(decode(raw), base);
		if (u.origin !== base.origin || u.username || u.password || u.protocol !== "https:" || u.href === base.href) return null;
		for (const key of [
			"fraza",
			"keywords",
			"tekst",
			"ksiazki",
			"woos",
			"search_text",
			"q",
			"query",
			"search_query",
			"szukaj",
			"phrase",
			"s",
			"k",
			"_nkw"
		]) if (base.searchParams.has(key) && u.searchParams.get(key) !== base.searchParams.get(key)) return null;
		if (base.hostname.endsWith("vinted.pl") && u.pathname !== "/catalog/2312-books") return null;
		return u.href;
	} catch {
		return null;
	}
}
function nextSearchPage(html, current) {
	for (const m of html.matchAll(/<(?:a|link)\b([^>]*)>/gi)) {
		const tag = m[1];
		if (/\bdisabled\b|aria-disabled=["']true/.test(tag)) continue;
		const label = [
			attr$2(tag, "rel"),
			attr$2(tag, "aria-label"),
			attr$2(tag, "title"),
			attr$2(tag, "class")
		].join(" ");
		if (/\bnext\b|nast[eę]pna(?: strona)?|pagination__next|pagination-next/i.test(label)) {
			const url = safeNext(attr$2(tag, "href"), current);
			if (url) return url;
		}
	}
	if (new URL(current).hostname.endsWith("vinted.pl")) {
		const chunks = [];
		for (const m of html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)) try {
			const p = JSON.parse(m[1]);
			if (p[0] === 1 && typeof p[1] === "string") chunks.push(p[1]);
		} catch {}
		const p = chunks.join("").match(/"pagination"\s*:\s*\{[^{}]*\}/)?.[0];
		if (p) try {
			const pagination = JSON.parse("{" + p + "}").pagination;
			const page = pagination.currentPage ?? pagination.current_page;
			const total = pagination.totalPages ?? pagination.total_pages;
			if (Number.isInteger(page) && Number.isInteger(total) && page > 0 && page < total) {
				const u = new URL(current);
				u.searchParams.set("page", String(page + 1));
				return u.href;
			}
		} catch {}
	}
	return null;
}
async function readSearchPages(start, read, limit = 3) {
	const pages = [], seen = /* @__PURE__ */ new Set(), contents = /* @__PURE__ */ new Set();
	let url = start, partial = false, error;
	let reason = "";
	while (url && pages.length < limit) {
		if (seen.has(url)) {
			partial = true;
			reason = "Serwis powtórzył adres kolejnej strony.";
			break;
		}
		seen.add(url);
		let html;
		try {
			html = await withDeadline((signal) => read(url, signal), pages.length ? 6e3 : 12e3, "Przekroczono czas odczytu strony wyników.");
		} catch (e) {
			if (!pages.length) throw e;
			error = e;
			partial = true;
			reason = "Błąd kolejnej strony: " + (e instanceof Error ? e.message : String(e));
			break;
		}
		if (contents.has(html)) {
			partial = true;
			reason = "Serwis zwrócił ponownie tę samą stronę wyników.";
			break;
		}
		contents.add(html);
		pages.push({
			url,
			html
		});
		url = nextSearchPage(html, url);
	}
	if (url) {
		partial = true;
		if (!reason) reason = `Osiągnięto limit ${limit} stron; pozostały dalsze wyniki.`;
	}
	return {
		pages,
		partial,
		error,
		coverage: `Odczytano ${pages.length} stron wyników (limit ${limit}).${partial ? " Odczyt niepełny: " + reason : " Kolejne strony są odczytywane, gdy serwis udostępnia odnośnik lub dane paginacji."} Brak dopasowań nie potwierdza braku książki w całym serwisie.`
	};
}
//#endregion
//#region lib/antiquarian-sources.ts
var antiquarianSources = [
	{
		key: "evos",
		name: "Antykwariat Evos",
		url: "https://antykwariatevos.pl/"
	},
	{
		key: "gryf",
		name: "Antykwariat Gryf",
		url: "https://antykwariatgryf.pl/"
	},
	{
		key: "torun",
		name: "Toruński Antykwariat Księgarski",
		url: "https://antykwariat-torun.pl/"
	},
	{
		key: "kulturawraca",
		name: "Kultura Wraca",
		url: "https://kulturawraca.pl/"
	},
	{
		key: "blackbooks",
		name: "BlackBooks",
		url: "https://blackbooks.pl/"
	},
	{
		key: "antykwariatwarszawa",
		name: "Antykwariat Warszawa",
		url: "https://antykwariatwaw.pl/"
	},
	{
		key: "gelber",
		name: "Antykwariat Gelber",
		url: "https://antykwariat-gelber.pl/"
	},
	{
		key: "hobbit",
		name: "Antykwariat Hobbit",
		url: "https://antykwariathobbit.pl/"
	},
	{
		key: "sobieski",
		name: "Antykwariat Sobieski",
		url: "https://antyksobieski.pl/"
	},
	{
		key: "szarlatan",
		name: "Antykwariat Szarlatan",
		url: "https://szarlatan.pl/"
	},
	{
		key: "conroy",
		name: "Antykwariat Conroy",
		url: "https://www.antykwariat-conroy.pl/"
	},
	{
		key: "pierwodruk",
		name: "Pierwodruk",
		url: "https://antykwariatpierwodruk.pl/sklep/"
	},
	{
		key: "poznan",
		name: "Antykwariat Poznań",
		url: "https://www.antykwariat.pl/"
	},
	{
		key: "bliskiestrony",
		name: "Bliskie Strony",
		url: "https://bliskiestrony.eu/"
	},
	{
		key: "authentic",
		name: "Antykwariat Authentic",
		url: "https://www.antykwariat-authentic.pl/"
	},
	{
		key: "nws",
		name: "Antykwariat NWS",
		url: "https://www.antykwariatnws.pl/"
	},
	{
		key: "bookway",
		name: "Bookway",
		url: "https://bookway.pl/"
	},
	{
		key: "kwadryga",
		name: "Kwadryga",
		url: "https://kwadryga.com/"
	},
	{
		key: "adumaru",
		name: "Adumaru",
		url: "https://adumaru.pl/"
	}
];
var isAntiquarianSource = (name) => [...antiquarianSources, ...polishAntiquarianCandidates].some((s) => s.name === name.split(" · ")[0]);
var antiquarianSearch = (url) => "https://www.google.com/search?q=" + encodeURIComponent("site:" + new URL(url).hostname + " ") + "{q}%20Warhammer%20ksi%C4%85%C5%BCka";
//#endregion
//#region lib/books.json
var books_default = /* @__PURE__ */ JSON.parse("[{\"id\":\"f0001\",\"title\":\"Trollslayer\",\"pl\":\"Zabójca Trolli\",\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":1,\"raw\":\"U0001 · Trollslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"William King\",\"year\":1999,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0001\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The First Omnibus\"]},{\"id\":\"f0002\",\"title\":\"Skavenslayer\",\"pl\":\"Zabójca Skavenów\",\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":2,\"raw\":\"U0002 · Skavenslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"William King\",\"year\":1999,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0002\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The First Omnibus\"]},{\"id\":\"f0003\",\"title\":\"Daemonslayer\",\"pl\":\"Zabójca Demonów\",\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":3,\"raw\":\"U0003 · Daemonslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"William King\",\"year\":1999,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0003\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The First Omnibus\"]},{\"id\":\"f0004\",\"title\":\"Dragonslayer\",\"pl\":\"Zabójca Smoków\",\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":4,\"raw\":\"U0004 · Dragonslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"William King\",\"year\":2000,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0004\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Second Omnibus\"]},{\"id\":\"f0005\",\"title\":\"Beastslayer\",\"pl\":\"Zabójca Bestii\",\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":5,\"raw\":\"U0005 · Beastslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"William King\",\"year\":2001,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0005\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Second Omnibus\"]},{\"id\":\"f0006\",\"title\":\"Vampireslayer\",\"pl\":\"Zabójca Wampirów\",\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":6,\"raw\":\"U0006 · Vampireslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"William King\",\"year\":2001,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0006\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Second Omnibus\"]},{\"id\":\"f0007\",\"title\":\"Giantslayer\",\"pl\":\"Zabójca Gigantów\",\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":7,\"raw\":\"U0007 · Giantslayer · powieść · samodzielny druk PL potwierdzony (W0017)\",\"uncertain\":false,\"note\":\"samodzielny druk PL potwierdzony (W0017). Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"William King\",\"year\":2003,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"samodzielny druk PL potwierdzony (W0017)\",\"workId\":\"U0007\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Third Omnibus\"]},{\"id\":\"f0008\",\"title\":\"Orcslayer\",\"pl\":\"Zabójca Orków\",\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":1,\"raw\":\"U0008 · Orcslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nathan Long\",\"year\":2006,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0008\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Third Omnibus\"]},{\"id\":\"f0009\",\"title\":\"Manslayer\",\"pl\":\"Zabójca Ludzi\",\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":2,\"raw\":\"U0009 · Manslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nathan Long\",\"year\":2007,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0009\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Third Omnibus\"]},{\"id\":\"f0010\",\"title\":\"Elfslayer\",\"pl\":\"Zabójca Elfów\",\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":3,\"raw\":\"U0010 · Elfslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nathan Long\",\"year\":2008,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0010\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: Fourth Omnibus\"]},{\"id\":\"f0011\",\"title\":\"Shamanslayer\",\"pl\":\"Zabójca Szamanów\",\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":4,\"raw\":\"U0011 · Shamanslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nathan Long\",\"year\":2009,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0011\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: Fourth Omnibus\"]},{\"id\":\"f0012\",\"title\":\"Zombieslayer\",\"pl\":\"Zabójca Zombi\",\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":5,\"raw\":\"U0012 · Zombieslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nathan Long\",\"year\":2010,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0012\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: Fourth Omnibus\"]},{\"id\":\"f0013\",\"title\":\"Road of Skulls\",\"pl\":null,\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":1,\"raw\":\"U0025 · Road of Skulls · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Josh Reynolds\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0025\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Fifth Omnibus\"]},{\"id\":\"f0014\",\"title\":\"City of the Damned\",\"pl\":\"Miasto potępionych\",\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":2,\"raw\":\"U0026 · City of the Damned · powieść · potwierdzone konkretne wydanie\",\"uncertain\":false,\"note\":\"potwierdzone konkretne wydanie. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"David Guymer\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"potwierdzone konkretne wydanie\",\"workId\":\"U0026\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek & Felix: The Sixth Omnibus\"]},{\"id\":\"f0015\",\"title\":\"The Serpent Queen\",\"pl\":null,\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":3,\"raw\":\"U0027 · The Serpent Queen · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Josh Reynolds\",\"year\":2014,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0027\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Fifth Omnibus\"]},{\"id\":\"f0016\",\"title\":\"Kinslayer\",\"pl\":null,\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":4,\"raw\":\"U0028 · Kinslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"David Guymer\",\"year\":2014,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0028\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek & Felix: The Sixth Omnibus\"]},{\"id\":\"f0017\",\"title\":\"Slayer\",\"pl\":null,\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":5,\"raw\":\"U0029 · Slayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"David Guymer\",\"year\":2015,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0029\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek & Felix: The Sixth Omnibus\"]},{\"id\":\"f0018\",\"title\":\"Redhand’s Daughter\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":1,\"raw\":\"U0321 · Redhand’s Daughter · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0321\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Third Omnibus\"]},{\"id\":\"f0019\",\"title\":\"Charnel Congress\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":2,\"raw\":\"U0331 · Charnel Congress · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0331\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Fifth Omnibus\"]},{\"id\":\"f0020\",\"title\":\"The Lost Kinsmen\",\"pl\":null,\"series\":\"Fantasy · Gotrek i Felix: dodatki\",\"number\":3,\"raw\":\"3. The Lost Kinsmen (1990; O)                     różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: 1990. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":1990,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0021\",\"title\":\"Death and Glory\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":4,\"raw\":\"U0312 · Death and Glory · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0312\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The First Omnibus\"]},{\"id\":\"f0022\",\"title\":\"Lord of Undeath\",\"pl\":null,\"series\":\"AoS · The Realmgate Wars\",\"number\":5,\"raw\":\"U0207 · Lord of Undeath · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2016,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0207\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Second Omnibus\"]},{\"id\":\"f0023\",\"title\":\"Red Snow\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":6,\"raw\":\"U0323 · Red Snow · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0323\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Third Omnibus\"]},{\"id\":\"f0024\",\"title\":\"The Oberwald Ripper\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":7,\"raw\":\"U0322 · The Oberwald Ripper · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0322\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Third Omnibus\"]},{\"id\":\"f0025\",\"title\":\"Blood Sport\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":8,\"raw\":\"U0314 · Blood Sport · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0314\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The First Omnibus\"]},{\"id\":\"f0026\",\"title\":\"The Contest\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":9,\"raw\":\"U0335 · The Contest · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0335\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Fifth Omnibus\"]},{\"id\":\"f0027\",\"title\":\"Berthold’s Beard\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":10,\"raw\":\"U0333 · Berthold’s Beard · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0333\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Fifth Omnibus\"]},{\"id\":\"f0028\",\"title\":\"Marriage of Moment\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":11,\"raw\":\"U0332 · Marriage of Moment · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0332\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Fifth Omnibus\"]},{\"id\":\"f0029\",\"title\":\"Rememberers\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":12,\"raw\":\"U0328 · Rememberers · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0328\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek & Felix: The Sixth Omnibus\"]},{\"id\":\"f0030\",\"title\":\"The Tilean’s Talisman\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":13,\"raw\":\"U0317 · The Tilean’s Talisman · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0317\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Second Omnibus\"]},{\"id\":\"f0031\",\"title\":\"The Two Crowns of Ras Karim\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":14,\"raw\":\"U0318 · The Two Crowns of Ras Karim · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0318\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Second Omnibus\"]},{\"id\":\"f0032\",\"title\":\"A Cask of Wynters\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":15,\"raw\":\"U0320 · A Cask of Wynters · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0320\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Second Omnibus\"]},{\"id\":\"f0033\",\"title\":\"Kineater\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":16,\"raw\":\"U0315 · Kineater · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0315\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The First Omnibus\"]},{\"id\":\"f0034\",\"title\":\"Last Orders\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":17,\"raw\":\"U0324 · Last Orders · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0324\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Third Omnibus\"]},{\"id\":\"f0035\",\"title\":\"Mind-Stealer\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":18,\"raw\":\"U0316 · Mind-Stealer · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0316\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The First Omnibus\"]},{\"id\":\"f0036\",\"title\":\"Prophecy\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":19,\"raw\":\"U0319 · Prophecy · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0319\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Second Omnibus\"]},{\"id\":\"f0037\",\"title\":\"Slayer’s Honour\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":20,\"raw\":\"U0326 · Slayer’s Honour · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0326\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: Fourth Omnibus\"]},{\"id\":\"f0038\",\"title\":\"The Funeral of Gotrek Gurnisson\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":21,\"raw\":\"U0327 · The Funeral of Gotrek Gurnisson · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0327\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: Fourth Omnibus\"]},{\"id\":\"f0039\",\"title\":\"A Place of Quiet Assembly\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":22,\"raw\":\"U0313 · A Place of Quiet Assembly · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0313\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The First Omnibus\"]},{\"id\":\"f0040\",\"title\":\"Into the Valley of Death\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":1,\"raw\":\"U0336 · Into the Valley of Death · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"N\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0336\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Fifth Omnibus\"]},{\"id\":\"f0041\",\"title\":\"The Reckoning\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":2,\"raw\":\"U0334 · The Reckoning · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"N\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0334\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Fifth Omnibus\"]},{\"id\":\"f0042\",\"title\":\"Gotrek and Felix: The Anthology\",\"pl\":null,\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":1,\"raw\":\"U0030 · Gotrek and Felix: The Anthology · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0030\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0043\",\"title\":\"Gotrek and Felix: Lost Tales\",\"pl\":null,\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":2,\"raw\":\"U0031 · Gotrek and Felix: Lost Tales · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0031\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0044\",\"title\":\"Gotrek and Felix: Myths and Legends\",\"pl\":null,\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":3,\"raw\":\"U0032 · Gotrek and Felix: Myths and Legends · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0032\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0045\",\"title\":\"Gotrek and Felix: The First Omnibus\",\"pl\":\"Przygody Gotreka i Felixa — Omnibus I\",\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":4,\"raw\":\"U0013 · Gotrek and Felix: The First Omnibus · zbiór / omnibus · potwierdzone konkretne wydanie\",\"uncertain\":false,\"note\":\"potwierdzone konkretne wydanie. Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji [źródło BL]\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"potwierdzone konkretne wydanie\",\"workId\":\"U0013\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Trollslayer\",\"Skavenslayer\",\"Daemonslayer\",\"Death and Glory\",\"A Place of Quiet Assembly\",\"Blood Sport\",\"Kineater\",\"Mind-Stealer\"],\"omnibusTitles\":[]},{\"id\":\"f0046\",\"title\":\"Gotrek and Felix: The Second Omnibus\",\"pl\":\"Przygody Gotreka i Felixa — Omnibus II\",\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":5,\"raw\":\"U0014 · Gotrek and Felix: The Second Omnibus · zbiór / omnibus · potwierdzone konkretne wydanie\",\"uncertain\":false,\"note\":\"potwierdzone konkretne wydanie. Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji [źródło BL]\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"potwierdzone konkretne wydanie\",\"workId\":\"U0014\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Dragonslayer\",\"Beastslayer\",\"Vampireslayer\",\"The Tilean’s Talisman\",\"Lord of Undeath\",\"The Two Crowns of Ras Karim\",\"Prophecy\",\"A Cask of Wynters\"],\"omnibusTitles\":[]},{\"id\":\"f0047\",\"title\":\"Gotrek and Felix: The Third Omnibus\",\"pl\":\"Przygody Gotreka i Felixa — Omnibus III\",\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":6,\"raw\":\"U0015 · Gotrek and Felix: The Third Omnibus · zbiór / omnibus · potwierdzone konkretne wydanie\",\"uncertain\":false,\"note\":\"potwierdzone konkretne wydanie. Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji [źródło BL]\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"potwierdzone konkretne wydanie\",\"workId\":\"U0015\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Giantslayer\",\"Redhand’s Daughter\",\"Orcslayer\",\"Manslayer\",\"The Oberwald Ripper\",\"Red Snow\",\"Last Orders\"],\"omnibusTitles\":[]},{\"id\":\"f0048\",\"title\":\"Gotrek and Felix: Fourth Omnibus\",\"pl\":null,\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":7,\"raw\":\"U0033 · Gotrek and Felix: Fourth Omnibus · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji [źródło BL]\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0033\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Elfslayer\",\"Shamanslayer\",\"Zombieslayer\",\"Slayer of the Storm God\",\"Slayer’s Honour\",\"The Funeral of Gotrek Gurnisson\"],\"omnibusTitles\":[]},{\"id\":\"f0049\",\"title\":\"Gotrek and Felix: The Fifth Omnibus\",\"pl\":null,\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":8,\"raw\":\"U0034 · Gotrek and Felix: The Fifth Omnibus · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji [źródło BL]\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0034\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Road of Skulls\",\"The Serpent Queen\",\"Charnel Congress\",\"Marriage of Moment\",\"Berthold’s Beard\",\"The Reckoning\",\"The Contest\",\"Into the Valley of Death\",\"Curse of the Everliving\"],\"omnibusTitles\":[]},{\"id\":\"f0050\",\"title\":\"The Daemon’s Curse\",\"pl\":\"Klątwa Demona\",\"series\":\"Fantasy · Malus Darkblade\",\"number\":1,\"raw\":\"U0036 · The Daemon’s Curse · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Dan Abnett / Mike Lee\",\"year\":2005,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0036\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Chronicles of Malus Darkblade: Volume One\"]},{\"id\":\"f0051\",\"title\":\"Bloodstorm\",\"pl\":\"Krwawy Sztorm\",\"series\":\"Fantasy · Malus Darkblade\",\"number\":2,\"raw\":\"U0037 · Bloodstorm · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Dan Abnett / Mike Lee\",\"year\":2005,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0037\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Chronicles of Malus Darkblade: Volume One\"]},{\"id\":\"f0052\",\"title\":\"Reaper of Souls\",\"pl\":\"Żniwiarz Dusz\",\"series\":\"Fantasy · Malus Darkblade\",\"number\":3,\"raw\":\"U0038 · Reaper of Souls · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Dan Abnett / Mike Lee\",\"year\":2006,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0038\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Chronicles of Malus Darkblade: Volume One\"]},{\"id\":\"f0053\",\"title\":\"Warpsword\",\"pl\":\"Spaczony Miecz\",\"series\":\"Fantasy · Malus Darkblade\",\"number\":4,\"raw\":\"U0039 · Warpsword · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Dan Abnett / Mike Lee\",\"year\":2007,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0039\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Chronicles of Malus Darkblade: Volume Two\"]},{\"id\":\"f0054\",\"title\":\"Lord of Ruin\",\"pl\":\"Władca Zniszczenia\",\"series\":\"Fantasy · Malus Darkblade\",\"number\":5,\"raw\":\"U0040 · Lord of Ruin · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Dan Abnett / Mike Lee\",\"year\":2007,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0040\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Chronicles of Malus Darkblade: Volume Two\"]},{\"id\":\"f0055\",\"title\":\"Deathblade\",\"pl\":null,\"series\":\"Fantasy · Malus Darkblade\",\"number\":1,\"raw\":\"U0041 · Deathblade · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2015,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0041\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Chronicles of Malus Darkblade: Volume Two\"]},{\"id\":\"f0056\",\"title\":\"The Blood Price\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":1,\"raw\":\"U0329 · The Blood Price · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0329\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Chronicles of Malus Darkblade: Volume One\"]},{\"id\":\"f0057\",\"title\":\"Bloodwalker\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":2,\"raw\":\"U0330 · Bloodwalker · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0330\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Chronicles of Malus Darkblade: Volume Two\"]},{\"id\":\"f0058\",\"title\":\"Bloodborn\",\"pl\":\"Zrodzona we krwi\",\"series\":\"Fantasy · Ulrika\",\"number\":1,\"raw\":\"U0016 · Bloodborn · powieść · potwierdzone konkretne wydanie\",\"uncertain\":false,\"note\":\"potwierdzone konkretne wydanie. Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nathan Long\",\"year\":2010,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"potwierdzone konkretne wydanie\",\"workId\":\"U0016\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Ulrika the Vampire: The Omnibus\"]},{\"id\":\"f0059\",\"title\":\"Bloodforged\",\"pl\":\"Zahartowana we krwi\",\"series\":\"Fantasy · Ulrika\",\"number\":2,\"raw\":\"U0017 · Bloodforged · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 1. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nathan Long\",\"year\":2011,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0017\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Ulrika the Vampire: The Omnibus\"]},{\"id\":\"f0060\",\"title\":\"Bloodsworn\",\"pl\":\"Zaprzysiężona we krwi\",\"series\":\"Fantasy · Ulrika\",\"number\":3,\"raw\":\"U0044 · Bloodsworn · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nathan Long\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0044\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Ulrika the Vampire: The Omnibus\"]},{\"id\":\"f0061\",\"title\":\"Ulrika the Vampire: The Omnibus\",\"pl\":\"Wampirzyca Ulrika — Omnibus\",\"series\":\"Fantasy · Ulrika\",\"number\":1,\"raw\":\"U0045 · Ulrika the Vampire: The Omnibus · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"Nathan Long\",\"year\":2018,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0045\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Bloodborn\",\"Bloodforged\",\"Bloodsworn\"],\"omnibusTitles\":[]},{\"id\":\"f0062\",\"title\":\"Drachenfels\",\"pl\":null,\"series\":\"Fantasy · Genevieve\",\"number\":1,\"raw\":\"U0046 · Drachenfels · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Jack Yeovil / Kim Newman\",\"year\":1989,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0046\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0063\",\"title\":\"Genevieve Undead\",\"pl\":null,\"series\":\"Fantasy · Genevieve\",\"number\":2,\"raw\":\"U0047 · Genevieve Undead · zbiór nowel · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"zbiór nowel\",\"author\":\"Jack Yeovil (Kim Newman)\",\"year\":1993,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0047\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0064\",\"title\":\"Beasts in Velvet\",\"pl\":null,\"series\":\"Fantasy · Genevieve\",\"number\":3,\"raw\":\"U0048 · Beasts in Velvet · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Jack Yeovil / Kim Newman\",\"year\":1991,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0048\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0065\",\"title\":\"Silver Nails\",\"pl\":null,\"series\":\"Fantasy · Genevieve\",\"number\":4,\"raw\":\"U0049 · Silver Nails · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"Jack Yeovil (Kim Newman)\",\"year\":2002,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0049\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0066\",\"title\":\"Inheritance\",\"pl\":null,\"series\":\"Fantasy · Von Carstein\",\"number\":1,\"raw\":\"U0050 · Inheritance · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Steven Savile\",\"year\":2006,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0050\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Vampire Wars\"]},{\"id\":\"f0067\",\"title\":\"Dominion\",\"pl\":null,\"series\":\"Fantasy · Von Carstein\",\"number\":2,\"raw\":\"U0051 · Dominion · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Steven Savile\",\"year\":2006,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0051\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Vampire Wars\"]},{\"id\":\"f0068\",\"title\":\"Retribution\",\"pl\":null,\"series\":\"Fantasy · Von Carstein\",\"number\":3,\"raw\":\"U0052 · Retribution · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Steven Savile\",\"year\":2007,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0052\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Vampire Wars\"]},{\"id\":\"f0069\",\"title\":\"Death’s Cold Kiss\",\"pl\":null,\"series\":\"Fantasy · Von Carstein\",\"number\":1,\"raw\":\"U0053 · Death’s Cold Kiss · nowela · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"nowela\",\"author\":\"Steven Savile\",\"year\":2006,\"universe\":\"Fantasy\",\"publicationType\":\"N\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0053\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0070\",\"title\":\"The Court of the Crimson Queen\",\"pl\":null,\"series\":\"Fantasy · Von Carstein\",\"number\":2,\"raw\":\"U0054 · The Court of the Crimson Queen · nowela · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"nowela\",\"author\":\"Steven Savile\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"N\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0054\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0071\",\"title\":\"Grey Seer\",\"pl\":\"Szary Prorok\",\"series\":\"Fantasy · Thanquol\",\"number\":1,\"raw\":\"U0019 · Grey Seer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2009,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0019\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0072\",\"title\":\"Temple of the Serpent\",\"pl\":\"Świątynia Węża\",\"series\":\"Fantasy · Thanquol\",\"number\":2,\"raw\":\"U0020 · Temple of the Serpent · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2010,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0020\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0073\",\"title\":\"Thanquol’s Doom\",\"pl\":\"Zagłada Thanquola\",\"series\":\"Fantasy · Thanquol\",\"number\":3,\"raw\":\"U0021 · Thanquol’s Doom · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2011,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0021\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0074\",\"title\":\"Thanquol Triumphant\",\"pl\":null,\"series\":\"Fantasy · Thanquol: dodatki\",\"number\":1,\"raw\":\"1. Thanquol Triumphant (2019; O)                  C. L. Werner · PL: niezweryfikowane\",\"uncertain\":false,\"note\":\"Pierwsze wydanie: 2019. Autor wg PDF: C. L. Werner. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"C. L. Werner\",\"year\":2019,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0075\",\"title\":\"Mind-Stealer\",\"pl\":null,\"series\":\"Fantasy · Thanquol: dodatki\",\"number\":2,\"raw\":\"2. Mind-Stealer (2012; O)                         C. L. Werner · PL: niezweryfikowane\",\"uncertain\":false,\"note\":\"Pierwsze wydanie: 2012. Autor wg PDF: C. L. Werner. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"C. L. Werner\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0076\",\"title\":\"Witch Hunter\",\"pl\":null,\"series\":\"Fantasy · Mathias Thulmann\",\"number\":1,\"raw\":\"U0055 · Witch Hunter · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2004,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0055\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Mathias Thulmann: Witch Hunter\"]},{\"id\":\"f0077\",\"title\":\"Witch Finder\",\"pl\":null,\"series\":\"Fantasy · Mathias Thulmann\",\"number\":2,\"raw\":\"U0056 · Witch Finder · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2005,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0056\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Mathias Thulmann: Witch Hunter\"]},{\"id\":\"f0078\",\"title\":\"Witch Killer\",\"pl\":null,\"series\":\"Fantasy · Mathias Thulmann\",\"number\":3,\"raw\":\"U0057 · Witch Killer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2006,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0057\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Mathias Thulmann: Witch Hunter\"]},{\"id\":\"f0079\",\"title\":\"A Choice of Hatreds\",\"pl\":null,\"series\":\"Fantasy · Mathias Thulmann: opowiadania\",\"number\":1,\"raw\":\"1. A Choice of Hatreds (?; O)                     C. L. Werner · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: C. L. Werner. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"C. L. Werner\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0080\",\"title\":\"Meat Wagon\",\"pl\":null,\"series\":\"Fantasy · Mathias Thulmann: opowiadania\",\"number\":2,\"raw\":\"2. Meat Wagon (?; O)                              C. L. Werner · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: C. L. Werner. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"C. L. Werner\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0081\",\"title\":\"Witch Work\",\"pl\":null,\"series\":\"Fantasy · Mathias Thulmann: opowiadania\",\"number\":3,\"raw\":\"3. Witch Work (?; O)                              C. L. Werner · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: C. L. Werner. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"C. L. Werner\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0082\",\"title\":\"Mathias Thulmann: Witch Hunter\",\"pl\":\"Mathias Thulmann: Łowca czarownic — Omnibus\",\"series\":\"Fantasy · Mathias Thulmann\",\"number\":1,\"raw\":\"U0022 · Mathias Thulmann: Witch Hunter · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"C. L. Werner\",\"year\":2008,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0022\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Witch Hunter\",\"Witch Finder\",\"Witch Killer\"],\"omnibusTitles\":[]},{\"id\":\"f0083\",\"title\":\"Blood Money\",\"pl\":\"Krwawa forsa\",\"series\":\"Fantasy · Brunner\",\"number\":1,\"raw\":\"U0058 · Blood Money · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2003,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0058\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0084\",\"title\":\"Blood and Steel\",\"pl\":null,\"series\":\"Fantasy · Brunner\",\"number\":2,\"raw\":\"U0059 · Blood and Steel · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2003,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0059\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0085\",\"title\":\"Blood of the Dragon\",\"pl\":null,\"series\":\"Fantasy · Brunner\",\"number\":3,\"raw\":\"U0060 · Blood of the Dragon · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2004,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0060\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0086\",\"title\":\"What Price Vengeance\",\"pl\":null,\"series\":\"Fantasy · Brunner: dodatki\",\"number\":1,\"raw\":\"1. What Price Vengeance (2003; O)                 C. L. Werner · PL: niezweryfikowane\",\"uncertain\":false,\"note\":\"Pierwsze wydanie: 2003. Autor wg PDF: C. L. Werner. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"C. L. Werner\",\"year\":2003,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0087\",\"title\":\"The Burning Shore\",\"pl\":null,\"series\":\"Fantasy · Florin i Lorenzo\",\"number\":1,\"raw\":\"U0061 · The Burning Shore · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Robert Earl\",\"year\":2004,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0061\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0088\",\"title\":\"Wild Kingdoms\",\"pl\":null,\"series\":\"Fantasy · Florin i Lorenzo\",\"number\":2,\"raw\":\"U0062 · Wild Kingdoms · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Robert Earl\",\"year\":2004,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0062\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0089\",\"title\":\"Savage City\",\"pl\":null,\"series\":\"Fantasy · Florin i Lorenzo\",\"number\":3,\"raw\":\"U0063 · Savage City · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Robert Earl\",\"year\":2005,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0063\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0090\",\"title\":\"Haute Cuisine\",\"pl\":null,\"series\":\"Fantasy · Florin i Lorenzo: opowiadania\",\"number\":1,\"raw\":\"1. Haute Cuisine (?; O)                           Robert Earl · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: Robert Earl. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Robert Earl\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0091\",\"title\":\"Noblesse Oblige\",\"pl\":null,\"series\":\"Fantasy · Florin i Lorenzo: opowiadania\",\"number\":2,\"raw\":\"2. Noblesse Oblige (?; O)                         Robert Earl · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: Robert Earl. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Robert Earl\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0092\",\"title\":\"The Ambassador\",\"pl\":null,\"series\":\"Fantasy · Ambassador Chronicles\",\"number\":1,\"raw\":\"U0064 · The Ambassador · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Graham McNeill\",\"year\":2003,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0064\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0093\",\"title\":\"Ursun’s Teeth\",\"pl\":null,\"series\":\"Fantasy · Ambassador Chronicles\",\"number\":2,\"raw\":\"U0065 · Ursun’s Teeth · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Graham McNeill\",\"year\":2004,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0065\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0094\",\"title\":\"Honour of the Grave\",\"pl\":null,\"series\":\"Fantasy · Angelika Fleischer\",\"number\":1,\"raw\":\"U0066 · Honour of the Grave · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Robin D. Laws\",\"year\":2003,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0066\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0095\",\"title\":\"Sacred Flesh\",\"pl\":null,\"series\":\"Fantasy · Angelika Fleischer\",\"number\":2,\"raw\":\"U0067 · Sacred Flesh · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Robin D. Laws\",\"year\":2004,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0067\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0096\",\"title\":\"Liar’s Peak\",\"pl\":null,\"series\":\"Fantasy · Angelika Fleischer\",\"number\":3,\"raw\":\"U0068 · Liar’s Peak · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Robin D. Laws\",\"year\":2005,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0068\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0097\",\"title\":\"Meat and Bone\",\"pl\":null,\"series\":\"Fantasy · Angelika Fleischer: opowiadania\",\"number\":1,\"raw\":\"1. Meat and Bone (?; O)                           Robin D. Laws · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: Robin D. Laws. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Robin D. Laws\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0098\",\"title\":\"Head Hunting\",\"pl\":null,\"series\":\"Fantasy · Angelika Fleischer: opowiadania\",\"number\":2,\"raw\":\"2. Head Hunting (?; O)                            Robin D. Laws · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: Robin D. Laws. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Robin D. Laws\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0099\",\"title\":\"The Dead and the Damned\",\"pl\":null,\"series\":\"Fantasy · Badenov’s Band\",\"number\":1,\"raw\":\"U0069 · The Dead and the Damned · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Jonathan Green\",\"year\":2002,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0069\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0100\",\"title\":\"Mark of the Beast\",\"pl\":null,\"series\":\"Fantasy · Badenov’s Band: opowiadania\",\"number\":1,\"raw\":\"1. Mark of the Beast (?; O)                       Jonathan Green · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: Jonathan Green. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Jonathan Green\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0101\",\"title\":\"The Nagenhof Bell\",\"pl\":null,\"series\":\"Fantasy · Badenov’s Band: opowiadania\",\"number\":2,\"raw\":\"2. The Nagenhof Bell (?; O)                       Jonathan Green · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: Jonathan Green. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Jonathan Green\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0102\",\"title\":\"Valnir’s Bane\",\"pl\":null,\"series\":\"Fantasy · Blackhearts\",\"number\":1,\"raw\":\"U0070 · Valnir’s Bane · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nathan Long\",\"year\":2004,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0070\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Blackhearts: The Omnibus\"]},{\"id\":\"f0103\",\"title\":\"The Broken Lance\",\"pl\":null,\"series\":\"Fantasy · Blackhearts\",\"number\":2,\"raw\":\"U0071 · The Broken Lance · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nathan Long\",\"year\":2005,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0071\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Blackhearts: The Omnibus\"]},{\"id\":\"f0104\",\"title\":\"Tainted Blood\",\"pl\":null,\"series\":\"Fantasy · Blackhearts\",\"number\":3,\"raw\":\"U0072 · Tainted Blood · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nathan Long\",\"year\":2006,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0072\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Blackhearts: The Omnibus\"]},{\"id\":\"f0105\",\"title\":\"Hetzau’s Follies\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":1,\"raw\":\"U0341 · Hetzau’s Follies · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0341\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Blackhearts: The Omnibus\"]},{\"id\":\"f0106\",\"title\":\"Rotten Fruit\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":2,\"raw\":\"U0340 · Rotten Fruit · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0340\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Blackhearts: The Omnibus\"]},{\"id\":\"f0107\",\"title\":\"Blood Bowl\",\"pl\":null,\"series\":\"Fantasy · Blood Bowl - poboczne Fantasy\",\"number\":1,\"raw\":\"U0074 · Blood Bowl · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Matt Forbeck\",\"year\":2005,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0074\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0108\",\"title\":\"Dead Ball\",\"pl\":null,\"series\":\"Fantasy · Blood Bowl - poboczne Fantasy\",\"number\":2,\"raw\":\"U0075 · Dead Ball · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Matt Forbeck\",\"year\":2005,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0075\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0109\",\"title\":\"Death Match\",\"pl\":null,\"series\":\"Fantasy · Blood Bowl - poboczne Fantasy\",\"number\":3,\"raw\":\"U0076 · Death Match · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Matt Forbeck\",\"year\":2006,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0076\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0110\",\"title\":\"Rumble in the Jungle\",\"pl\":null,\"series\":\"Fantasy · Blood Bowl - poboczne Fantasy\",\"number\":4,\"raw\":\"U0077 · Rumble in the Jungle · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Matt Forbeck\",\"year\":2007,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0077\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0111\",\"title\":\"Death’s Messenger\",\"pl\":null,\"series\":\"Fantasy · Blood on the Reik\",\"number\":1,\"raw\":\"U0078 · Death’s Messenger · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Sandy Mitchell\",\"year\":2005,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0078\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0112\",\"title\":\"Death’s City\",\"pl\":null,\"series\":\"Fantasy · Blood on the Reik\",\"number\":2,\"raw\":\"U0079 · Death’s City · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Sandy Mitchell\",\"year\":2005,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0079\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0113\",\"title\":\"Death’s Legacy\",\"pl\":null,\"series\":\"Fantasy · Blood on the Reik\",\"number\":3,\"raw\":\"U0080 · Death’s Legacy · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Sandy Mitchell\",\"year\":2006,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0080\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0114\",\"title\":\"Palace of the Plague Lord\",\"pl\":null,\"series\":\"Fantasy · Chaos Powers\",\"number\":1,\"raw\":\"U0023 · Palace of the Plague Lord · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2007,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0023\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0115\",\"title\":\"Blood for the Blood God\",\"pl\":null,\"series\":\"Fantasy · Chaos Powers\",\"number\":2,\"raw\":\"U0024 · Blood for the Blood God · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2008,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0024\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0116\",\"title\":\"Wulfrik\",\"pl\":null,\"series\":\"Fantasy · Chaos Powers\",\"number\":3,\"raw\":\"U0081 · Wulfrik · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2010,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0081\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0117\",\"title\":\"Day of the Daemon\",\"pl\":null,\"series\":\"Fantasy · Daemon’s Gates\",\"number\":1,\"raw\":\"U0083 · Day of the Daemon · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Aaron Rosenberg\",\"year\":2006,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0083\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0118\",\"title\":\"Night of the Daemon\",\"pl\":null,\"series\":\"Fantasy · Daemon’s Gates\",\"number\":2,\"raw\":\"U0084 · Night of the Daemon · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Aaron Rosenberg\",\"year\":2007,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0084\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0119\",\"title\":\"Hour of the Daemon\",\"pl\":null,\"series\":\"Fantasy · Daemon’s Gates\",\"number\":3,\"raw\":\"U0085 · Hour of the Daemon · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Aaron Rosenberg\",\"year\":2007,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0085\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0120\",\"title\":\"Grudge Bearer\",\"pl\":null,\"series\":\"Fantasy · Krasnoludy\",\"number\":1,\"raw\":\"U0086 · Grudge Bearer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Gav Thorpe\",\"year\":2005,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0086\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Masters of Steel and Stone\"]},{\"id\":\"f0121\",\"title\":\"Oathbreaker\",\"pl\":null,\"series\":\"Fantasy · Krasnoludy\",\"number\":2,\"raw\":\"U0087 · Oathbreaker · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nick Kyme\",\"year\":2008,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0087\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Masters of Steel and Stone\"]},{\"id\":\"f0122\",\"title\":\"Honourkeeper\",\"pl\":null,\"series\":\"Fantasy · Krasnoludy\",\"number\":3,\"raw\":\"U0088 · Honourkeeper · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nick Kyme\",\"year\":2009,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0088\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Masters of Steel and Stone\"]},{\"id\":\"f0123\",\"title\":\"Ancestral Honour\",\"pl\":null,\"series\":\"Fantasy · Krasnoludy: opowiadania\",\"number\":1,\"raw\":\"1. Ancestral Honour (?; O)                        różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0124\",\"title\":\"Guardians of the Forest\",\"pl\":null,\"series\":\"Fantasy · Elves\",\"number\":1,\"raw\":\"U0091 · Guardians of the Forest · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Graham McNeill\",\"year\":2005,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0091\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Elves: The Omnibus\"]},{\"id\":\"f0125\",\"title\":\"Defenders of Ulthuan\",\"pl\":null,\"series\":\"Fantasy · Elves\",\"number\":2,\"raw\":\"U0092 · Defenders of Ulthuan · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Graham McNeill\",\"year\":2007,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0092\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Elves: The Omnibus\"]},{\"id\":\"f0126\",\"title\":\"Sons of Ellyrion\",\"pl\":null,\"series\":\"Fantasy · Elves\",\"number\":3,\"raw\":\"U0093 · Sons of Ellyrion · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Graham McNeill\",\"year\":2011,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0093\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Elves: The Omnibus\"]},{\"id\":\"f0127\",\"title\":\"Freedom’s Home or Glory’s Grave\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":1,\"raw\":\"U0347 · Freedom’s Home or Glory’s Grave · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"Graham McNeill\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0347\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Elves: The Omnibus\"]},{\"id\":\"f0128\",\"title\":\"Kinstrife\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":2,\"raw\":\"U0345 · Kinstrife · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"Graham McNeill\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0345\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Elves: The Omnibus\"]},{\"id\":\"f0129\",\"title\":\"Deathmasque\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":3,\"raw\":\"U0346 · Deathmasque · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"Graham McNeill\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0346\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Elves: The Omnibus\"]},{\"id\":\"f0130\",\"title\":\"Reiksguard\",\"pl\":null,\"series\":\"Fantasy · Imperium\",\"number\":1,\"raw\":\"U0095 · Reiksguard · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2009,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0095\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0131\",\"title\":\"Iron Company\",\"pl\":null,\"series\":\"Fantasy · Imperium\",\"number\":2,\"raw\":\"U0096 · Iron Company · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2009,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0096\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0132\",\"title\":\"Call to Arms\",\"pl\":null,\"series\":\"Fantasy · Imperium\",\"number\":3,\"raw\":\"U0097 · Call to Arms · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2010,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0097\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0133\",\"title\":\"Grimblades\",\"pl\":null,\"series\":\"Fantasy · Imperium\",\"number\":4,\"raw\":\"U0098 · Grimblades · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2010,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0098\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0134\",\"title\":\"Warrior Priest\",\"pl\":null,\"series\":\"Fantasy · Imperium\",\"number\":5,\"raw\":\"U0099 · Warrior Priest · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2010,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0099\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0135\",\"title\":\"The Judgement of Crows\",\"pl\":null,\"series\":\"Fantasy · Imperium: opowiadania\",\"number\":1,\"raw\":\"1. The Judgement of Crows (?; O)                  różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0136\",\"title\":\"The March of Doom\",\"pl\":null,\"series\":\"Fantasy · Imperium: opowiadania\",\"number\":2,\"raw\":\"2. The March of Doom (?; O)                       różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0137\",\"title\":\"As Dead as Flesh\",\"pl\":null,\"series\":\"Fantasy · Imperium: opowiadania\",\"number\":3,\"raw\":\"3. As Dead as Flesh (?; O)                        różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0138\",\"title\":\"Dead Man’s Hand\",\"pl\":null,\"series\":\"Fantasy · Imperium: opowiadania\",\"number\":4,\"raw\":\"4. Dead Man’s Hand (?; O)                         różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0139\",\"title\":\"Sanctity\",\"pl\":null,\"series\":\"Fantasy · Imperium: opowiadania\",\"number\":5,\"raw\":\"5. Sanctity (?; O)                                różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0140\",\"title\":\"The Miracle at Berlau\",\"pl\":null,\"series\":\"Fantasy · Imperium: opowiadania\",\"number\":6,\"raw\":\"6. The Miracle at Berlau (?; O)                   różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0141\",\"title\":\"Gilead’s Blood\",\"pl\":null,\"series\":\"Fantasy · Gilead\",\"number\":1,\"raw\":\"U0102 · Gilead’s Blood · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Dan Abnett / Nik Vincent\",\"year\":2001,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0102\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0142\",\"title\":\"Gilead’s Curse\",\"pl\":null,\"series\":\"Fantasy · Gilead\",\"number\":2,\"raw\":\"U0103 · Gilead’s Curse · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Dan Abnett / Nik Vincent\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0103\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0143\",\"title\":\"Gilead’s Craft\",\"pl\":null,\"series\":\"Fantasy · Gilead: opowiadania\",\"number\":1,\"raw\":\"1. Gilead’s Craft (2012; O)                       Dan Abnett / Nik Vincent · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: 2012. Autor wg PDF: Dan Abnett / Nik Vincent. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"Dan Abnett / Nik Vincent\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0144\",\"title\":\"Knight Errant\",\"pl\":null,\"series\":\"Fantasy · Bretonnia\",\"number\":1,\"raw\":\"U0104 · Knight Errant · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Anthony Reynolds\",\"year\":2008,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0104\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Knights of Bretonnia\"]},{\"id\":\"f0145\",\"title\":\"Knight of the Realm\",\"pl\":null,\"series\":\"Fantasy · Bretonnia\",\"number\":2,\"raw\":\"U0105 · Knight of the Realm · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Anthony Reynolds\",\"year\":2009,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0105\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Knights of Bretonnia\"]},{\"id\":\"f0146\",\"title\":\"Questing Knight\",\"pl\":null,\"series\":\"Fantasy · Bretonnia\",\"number\":1,\"raw\":\"U0106 · Questing Knight · nowela · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"nowela\",\"author\":\"Anthony Reynolds\",\"year\":2010,\"universe\":\"Fantasy\",\"publicationType\":\"N\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0106\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Knights of Bretonnia\"]},{\"id\":\"f0147\",\"title\":\"Grail Knight\",\"pl\":null,\"series\":\"Fantasy · Bretonnia\",\"number\":2,\"raw\":\"U0107 · Grail Knight · nowela · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"nowela\",\"author\":\"Anthony Reynolds\",\"year\":2011,\"universe\":\"Fantasy\",\"publicationType\":\"N\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0107\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Knights of Bretonnia\"]},{\"id\":\"f0148\",\"title\":\"Rest Eternal\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":1,\"raw\":\"U0338 · Rest Eternal · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"Anthony Reynolds\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0338\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Knights of Bretonnia\"]},{\"id\":\"f0149\",\"title\":\"Dead Calm\",\"pl\":null,\"series\":\"Fantasy · Knights of Manaan\",\"number\":1,\"raw\":\"1. Dead Calm (2011; O)                            Josh Reynolds · PL: niezweryfikowane\",\"uncertain\":false,\"note\":\"Pierwsze wydanie: 2011. Autor wg PDF: Josh Reynolds. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Josh Reynolds\",\"year\":2011,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0150\",\"title\":\"Stormfels Teeth\",\"pl\":null,\"series\":\"Fantasy · Knights of Manaan\",\"number\":2,\"raw\":\"2. Stormfels Teeth (2012; O)                      Josh Reynolds · PL: niezweryfikowane\",\"uncertain\":false,\"note\":\"Pierwsze wydanie: 2012. Autor wg PDF: Josh Reynolds. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Josh Reynolds\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0151\",\"title\":\"Lords of the Marsh\",\"pl\":null,\"series\":\"Fantasy · Knights of Manaan\",\"number\":3,\"raw\":\"3. Lords of the Marsh (2012; O)                   Josh Reynolds · PL: niezweryfikowane\",\"uncertain\":false,\"note\":\"Pierwsze wydanie: 2012. Autor wg PDF: Josh Reynolds. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Josh Reynolds\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0152\",\"title\":\"Dead Man’s Party\",\"pl\":null,\"series\":\"Fantasy · Knights of Manaan\",\"number\":4,\"raw\":\"4. Dead Man’s Party (2012; O)                     Josh Reynolds · PL: niezweryfikowane\",\"uncertain\":false,\"note\":\"Pierwsze wydanie: 2012. Autor wg PDF: Josh Reynolds. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Josh Reynolds\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0153\",\"title\":\"Bernheimer’s Gun\",\"pl\":null,\"series\":\"Fantasy · Knights of Manaan\",\"number\":5,\"raw\":\"5. Bernheimer’s Gun (2014; O)                     Josh Reynolds · PL: niezweryfikowane\",\"uncertain\":false,\"note\":\"Pierwsze wydanie: 2014. Autor wg PDF: Josh Reynolds. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Josh Reynolds\",\"year\":2014,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0154\",\"title\":\"Konrad\",\"pl\":null,\"series\":\"Fantasy · Konrad\",\"number\":1,\"raw\":\"U0109 · Konrad · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"David Ferring\",\"year\":1990,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0109\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0155\",\"title\":\"Shadowbreed\",\"pl\":null,\"series\":\"Fantasy · Konrad\",\"number\":2,\"raw\":\"U0110 · Shadowbreed · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"David Ferring\",\"year\":1990,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0110\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0156\",\"title\":\"Warblade\",\"pl\":null,\"series\":\"Fantasy · Konrad\",\"number\":3,\"raw\":\"U0111 · Warblade · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"David Ferring\",\"year\":1993,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0111\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0157\",\"title\":\"A Murder in Marienburg\",\"pl\":null,\"series\":\"Fantasy · Marienburg\",\"number\":1,\"raw\":\"U0112 · A Murder in Marienburg · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"David Bishop\",\"year\":2007,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0112\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0158\",\"title\":\"A Massacre in Marienburg\",\"pl\":null,\"series\":\"Fantasy · Marienburg\",\"number\":2,\"raw\":\"U0113 · A Massacre in Marienburg · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"David Bishop\",\"year\":2008,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0113\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0159\",\"title\":\"Mark of Damnation\",\"pl\":null,\"series\":\"Fantasy · Marks of Chaos\",\"number\":1,\"raw\":\"U0114 · Mark of Damnation · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"James Wallis\",\"year\":2003,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0114\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0160\",\"title\":\"Mark of Heresy\",\"pl\":null,\"series\":\"Fantasy · Marks of Chaos\",\"number\":2,\"raw\":\"U0115 · Mark of Heresy · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"James Wallis\",\"year\":2003,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0115\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0161\",\"title\":\"No Rest for the Wicked\",\"pl\":null,\"series\":\"Fantasy · Marks of Chaos: opowiadania\",\"number\":1,\"raw\":\"1. No Rest for the Wicked (?; O)                  James Wallis · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: James Wallis. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"James Wallis\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0162\",\"title\":\"A Night Too Long\",\"pl\":null,\"series\":\"Fantasy · Marks of Chaos: opowiadania\",\"number\":2,\"raw\":\"2. A Night Too Long (?; O)                        James Wallis · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: James Wallis. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"James Wallis\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0163\",\"title\":\"Orion: The Vaults of Winter\",\"pl\":null,\"series\":\"Fantasy · Orion\",\"number\":1,\"raw\":\"U0116 · Orion: The Vaults of Winter · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Darius Hinks\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0116\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Warhammer Chronicles: The Orion Trilogy\"]},{\"id\":\"f0164\",\"title\":\"Orion: Tears of Isha\",\"pl\":null,\"series\":\"Fantasy · Orion\",\"number\":2,\"raw\":\"U0117 · Orion: Tears of Isha · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Darius Hinks\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0117\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Warhammer Chronicles: The Orion Trilogy\"]},{\"id\":\"f0165\",\"title\":\"Orion: The Council of Beasts\",\"pl\":null,\"series\":\"Fantasy · Orion\",\"number\":3,\"raw\":\"U0118 · Orion: The Council of Beasts · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Darius Hinks\",\"year\":2014,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0118\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Warhammer Chronicles: The Orion Trilogy\"]},{\"id\":\"f0166\",\"title\":\"The Claws of Chaos\",\"pl\":null,\"series\":\"Fantasy · Slaves to Darkness\",\"number\":1,\"raw\":\"U0120 · The Claws of Chaos · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Gav Thorpe\",\"year\":2002,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0120\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0167\",\"title\":\"The Blades of Chaos\",\"pl\":null,\"series\":\"Fantasy · Slaves to Darkness\",\"number\":2,\"raw\":\"U0121 · The Blades of Chaos · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Gav Thorpe\",\"year\":2003,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0121\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0168\",\"title\":\"The Heart of Chaos\",\"pl\":null,\"series\":\"Fantasy · Slaves to Darkness\",\"number\":3,\"raw\":\"U0122 · The Heart of Chaos · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Gav Thorpe\",\"year\":2004,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0122\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0169\",\"title\":\"Star of Erengrad\",\"pl\":null,\"series\":\"Fantasy · Stefan Kumansky\",\"number\":1,\"raw\":\"U0123 · Star of Erengrad · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Neil McIntosh\",\"year\":2002,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0123\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0170\",\"title\":\"Taint of Evil\",\"pl\":null,\"series\":\"Fantasy · Stefan Kumansky\",\"number\":2,\"raw\":\"U0124 · Taint of Evil · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Neil McIntosh\",\"year\":2003,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0124\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0171\",\"title\":\"Keepers of the Flame\",\"pl\":null,\"series\":\"Fantasy · Stefan Kumansky\",\"number\":3,\"raw\":\"U0125 · Keepers of the Flame · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Neil McIntosh\",\"year\":2005,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0125\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0172\",\"title\":\"Razumov’s Tomb\",\"pl\":null,\"series\":\"Fantasy · Storm of Magic\",\"number\":1,\"raw\":\"U0126 · Razumov’s Tomb · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2011,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0126\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0173\",\"title\":\"The Hour of Shadows\",\"pl\":null,\"series\":\"Fantasy · Storm of Magic\",\"number\":2,\"raw\":\"U0127 · The Hour of Shadows · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2011,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0127\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0174\",\"title\":\"Dragonmage\",\"pl\":null,\"series\":\"Fantasy · Storm of Magic\",\"number\":1,\"raw\":\"U0128 · Dragonmage · nowela · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"nowela\",\"author\":\"Chris Wraight\",\"year\":2011,\"universe\":\"Fantasy\",\"publicationType\":\"N\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0128\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0175\",\"title\":\"Zaragoz\",\"pl\":null,\"series\":\"Fantasy · Tales of Orfeo\",\"number\":1,\"raw\":\"U0129 · Zaragoz · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Brian Craig\",\"year\":1989,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0129\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0176\",\"title\":\"Plague Daemon\",\"pl\":null,\"series\":\"Fantasy · Tales of Orfeo\",\"number\":2,\"raw\":\"U0130 · Plague Daemon · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Brian Craig\",\"year\":1990,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0130\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0177\",\"title\":\"Storm Warriors\",\"pl\":null,\"series\":\"Fantasy · Tales of Orfeo\",\"number\":3,\"raw\":\"U0131 · Storm Warriors · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Brian Craig\",\"year\":1991,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0131\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0178\",\"title\":\"Hammers of Ulric\",\"pl\":null,\"series\":\"Fantasy · Thunder and Steel\",\"number\":1,\"raw\":\"U0132 · Hammers of Ulric · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Dan Abnett i inni\",\"year\":2000,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0132\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0179\",\"title\":\"Riders of the Dead\",\"pl\":null,\"series\":\"Fantasy · Thunder and Steel\",\"number\":2,\"raw\":\"U0133 · Riders of the Dead · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Dan Abnett i inni\",\"year\":2003,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0133\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0180\",\"title\":\"Swords of the Empire\",\"pl\":null,\"series\":\"Fantasy · Thunder and Steel: opowiadania\",\"number\":1,\"raw\":\"1. Swords of the Empire (?; O)                    Dan Abnett · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: Dan Abnett. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Dan Abnett\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0181\",\"title\":\"Shyi-zar\",\"pl\":null,\"series\":\"Fantasy · Thunder and Steel: opowiadania\",\"number\":2,\"raw\":\"2. Shyi-zar (?; O)                                Dan Abnett · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: Dan Abnett. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Dan Abnett\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0182\",\"title\":\"Heldenhammer\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Sigmar\",\"number\":1,\"raw\":\"U0134 · Heldenhammer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Graham McNeill\",\"year\":2008,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0134\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Legend of Sigmar\"]},{\"id\":\"f0183\",\"title\":\"Empire\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Sigmar\",\"number\":2,\"raw\":\"U0135 · Empire · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Graham McNeill\",\"year\":2009,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0135\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Legend of Sigmar\"]},{\"id\":\"f0184\",\"title\":\"God King\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Sigmar\",\"number\":3,\"raw\":\"U0136 · God King · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Graham McNeill\",\"year\":2011,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0136\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Legend of Sigmar\"]},{\"id\":\"f0185\",\"title\":\"Sword Guardian\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Sigmar\",\"number\":1,\"raw\":\"U0354 · Sword Guardian · opowiadanie · samodzielny druk niepotwierdzony\",\"uncertain\":true,\"note\":\"samodzielny druk niepotwierdzony. Uwagi źródłowe: Utwór potwierdzony jako element zbioru. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie\",\"author\":\"Graham McNeill\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"samodzielny druk niepotwierdzony\",\"workId\":\"U0354\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Legend of Sigmar\"]},{\"id\":\"f0186\",\"title\":\"Let the Great Axe Fall\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Sigmar\",\"number\":2,\"raw\":\"U0352 · Let the Great Axe Fall · opowiadanie · samodzielny druk niepotwierdzony\",\"uncertain\":true,\"note\":\"samodzielny druk niepotwierdzony. Uwagi źródłowe: Utwór potwierdzony jako element zbioru. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie\",\"author\":\"Graham McNeill\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"samodzielny druk niepotwierdzony\",\"workId\":\"U0352\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Legend of Sigmar\"]},{\"id\":\"f0187\",\"title\":\"Gods of Flesh and Blood\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Sigmar\",\"number\":3,\"raw\":\"U0353 · Gods of Flesh and Blood · opowiadanie · samodzielny druk niepotwierdzony\",\"uncertain\":true,\"note\":\"samodzielny druk niepotwierdzony. Uwagi źródłowe: Utwór potwierdzony jako element zbioru. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie\",\"author\":\"Graham McNeill\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"samodzielny druk niepotwierdzony\",\"workId\":\"U0353\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Legend of Sigmar\"]},{\"id\":\"f0188\",\"title\":\"Nagash the Sorcerer\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Nagash\",\"number\":1,\"raw\":\"U0138 · Nagash the Sorcerer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Mike Lee\",\"year\":2008,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0138\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Rise of Nagash\"]},{\"id\":\"f0189\",\"title\":\"Nagash the Unbroken\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Nagash\",\"number\":2,\"raw\":\"U0139 · Nagash the Unbroken · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Mike Lee\",\"year\":2010,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0139\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Rise of Nagash\"]},{\"id\":\"f0190\",\"title\":\"Nagash Immortal\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Nagash\",\"number\":3,\"raw\":\"U0140 · Nagash Immortal · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Mike Lee\",\"year\":2011,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0140\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Rise of Nagash\"]},{\"id\":\"f0191\",\"title\":\"Picking the Bones\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Nagash\",\"number\":1,\"raw\":\"U0362 · Picking the Bones · opowiadanie · samodzielny druk niepotwierdzony\",\"uncertain\":true,\"note\":\"samodzielny druk niepotwierdzony. Uwagi źródłowe: Black Library: The Rise of Nagash, eBook 2025. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie\",\"author\":\"Mike Lee\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"samodzielny druk niepotwierdzony\",\"workId\":\"U0362\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Rise of Nagash\"]},{\"id\":\"f0192\",\"title\":\"Malekith\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Sundering\",\"number\":1,\"raw\":\"U0142 · Malekith · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Gav Thorpe\",\"year\":2009,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0142\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Sundering\"]},{\"id\":\"f0193\",\"title\":\"Shadow King\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Sundering\",\"number\":2,\"raw\":\"U0143 · Shadow King · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Gav Thorpe\",\"year\":2010,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0143\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Sundering\"]},{\"id\":\"f0194\",\"title\":\"Caledor\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Sundering\",\"number\":3,\"raw\":\"U0144 · Caledor · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Gav Thorpe\",\"year\":2011,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0144\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Sundering\"]},{\"id\":\"f0195\",\"title\":\"Aenarion\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Sundering\",\"number\":1,\"raw\":\"U0145 · Aenarion · nowela · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"nowela\",\"author\":\"Gav Thorpe\",\"year\":2010,\"universe\":\"Fantasy\",\"publicationType\":\"N\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0145\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0196\",\"title\":\"The Bloody Handed\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Sundering\",\"number\":2,\"raw\":\"U0146 · The Bloody Handed · nowela · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"nowela\",\"author\":\"Gav Thorpe\",\"year\":2010,\"universe\":\"Fantasy\",\"publicationType\":\"N\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0146\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0197\",\"title\":\"The Dark Path\",\"pl\":null,\"series\":\"Fantasy · Time of Legends: Sundering - opowiadania\",\"number\":1,\"raw\":\"1. The Dark Path (?; O)                               Gav Thorpe · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: Gav Thorpe. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Gav Thorpe\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0198\",\"title\":\"Never Forgive\",\"pl\":null,\"series\":\"Fantasy · Time of Legends: Sundering - opowiadania\",\"number\":2,\"raw\":\"2. Never Forgive (?; O)                               Gav Thorpe · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: Gav Thorpe. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Gav Thorpe\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0199\",\"title\":\"Dead Winter\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Black Plague\",\"number\":1,\"raw\":\"U0148 · Dead Winter · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0148\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Skaven Wars: The Black Plague Trilogy\"]},{\"id\":\"f0200\",\"title\":\"Blighted Empire\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Black Plague\",\"number\":2,\"raw\":\"U0149 · Blighted Empire · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0149\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Skaven Wars: The Black Plague Trilogy\"]},{\"id\":\"f0201\",\"title\":\"Wolf of Sigmar\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Black Plague\",\"number\":3,\"raw\":\"U0150 · Wolf of Sigmar · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2014,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0150\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Skaven Wars: The Black Plague Trilogy\"]},{\"id\":\"f0202\",\"title\":\"Plague Doktor\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":1,\"raw\":\"U0349 · Plague Doktor · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"C. L. Werner\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0349\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Skaven Wars: The Black Plague Trilogy\"]},{\"id\":\"f0203\",\"title\":\"Plague Priest\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":2,\"raw\":\"U0348 · Plague Priest · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"C. L. Werner\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0348\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Skaven Wars: The Black Plague Trilogy\"]},{\"id\":\"f0204\",\"title\":\"A Question of Faith\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":3,\"raw\":\"U0350 · A Question of Faith · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"C. L. Werner\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0350\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Skaven Wars: The Black Plague Trilogy\"]},{\"id\":\"f0205\",\"title\":\"The Last Man\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":4,\"raw\":\"U0351 · The Last Man · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"C. L. Werner\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0351\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Skaven Wars: The Black Plague Trilogy\"]},{\"id\":\"f0206\",\"title\":\"The Great Betrayal\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - War of Vengeance\",\"number\":1,\"raw\":\"U0152 · The Great Betrayal · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nick Kyme\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0152\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The War of Vengeance\"]},{\"id\":\"f0207\",\"title\":\"Master of Dragons\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - War of Vengeance\",\"number\":2,\"raw\":\"U0153 · Master of Dragons · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Chris Wraight\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0153\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The War of Vengeance\"]},{\"id\":\"f0208\",\"title\":\"Curse of the Phoenix Crown\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - War of Vengeance\",\"number\":3,\"raw\":\"U0154 · Curse of the Phoenix Crown · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2015,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0154\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The War of Vengeance\"]},{\"id\":\"f0209\",\"title\":\"Neferata\",\"pl\":null,\"series\":\"Fantasy · Blood of Nagash\",\"number\":1,\"raw\":\"U0156 · Neferata · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Josh Reynolds\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0156\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0210\",\"title\":\"Master of Death\",\"pl\":null,\"series\":\"Fantasy · Blood of Nagash\",\"number\":2,\"raw\":\"U0157 · Master of Death · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Josh Reynolds\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0157\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0211\",\"title\":\"Master of Mourkain\",\"pl\":null,\"series\":\"Fantasy · Blood of Nagash: opowiadania\",\"number\":1,\"raw\":\"1. Master of Mourkain (?; O)                         Josh Reynolds · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: Josh Reynolds. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Josh Reynolds\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0212\",\"title\":\"Fangs of the Asp\",\"pl\":null,\"series\":\"Fantasy · Blood of Nagash: opowiadania\",\"number\":2,\"raw\":\"2. Fangs of the Asp (2012; O)                        Josh Reynolds · PL: niezweryfikowane\",\"uncertain\":false,\"note\":\"Pierwsze wydanie: 2012. Autor wg PDF: Josh Reynolds. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Josh Reynolds\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0213\",\"title\":\"Blood of Aenarion\",\"pl\":null,\"series\":\"Fantasy · Tyrion i Teclis\",\"number\":1,\"raw\":\"U0158 · Blood of Aenarion · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"William King\",\"year\":2011,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0158\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Tyrion and Teclis Omnibus\"]},{\"id\":\"f0214\",\"title\":\"Sword of Caledor\",\"pl\":null,\"series\":\"Fantasy · Tyrion i Teclis\",\"number\":2,\"raw\":\"U0159 · Sword of Caledor · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"William King\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0159\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Tyrion and Teclis Omnibus\"]},{\"id\":\"f0215\",\"title\":\"Bane of Malekith\",\"pl\":null,\"series\":\"Fantasy · Tyrion i Teclis\",\"number\":3,\"raw\":\"U0160 · Bane of Malekith · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"William King\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0160\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"The Tyrion and Teclis Omnibus\"]},{\"id\":\"f0216\",\"title\":\"Ancient Blood\",\"pl\":null,\"series\":\"Fantasy · Vampires\",\"number\":1,\"raw\":\"U0162 · Ancient Blood · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Robert Earl\",\"year\":2008,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0162\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0217\",\"title\":\"Curse of the Necrarch\",\"pl\":null,\"series\":\"Fantasy · Vampires\",\"number\":2,\"raw\":\"U0163 · Curse of the Necrarch · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Steven Savile\",\"year\":2008,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0163\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0218\",\"title\":\"Luthor Huss\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes\",\"number\":1,\"raw\":\"U0166 · Luthor Huss · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Chris Wraight\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0166\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0219\",\"title\":\"Sword of Justice\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes\",\"number\":2,\"raw\":\"U0167 · Sword of Justice · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Chris Wraight\",\"year\":2010,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0167\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0220\",\"title\":\"Sword of Vengeance\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes\",\"number\":3,\"raw\":\"U0168 · Sword of Vengeance · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Chris Wraight\",\"year\":2011,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0168\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0221\",\"title\":\"Headtaker\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes\",\"number\":4,\"raw\":\"U0169 · Headtaker · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0169\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Warlords of Karak Eight Peaks\"]},{\"id\":\"f0222\",\"title\":\"Skarsnik\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes\",\"number\":5,\"raw\":\"U0170 · Skarsnik · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0170\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Warlords of Karak Eight Peaks\"]},{\"id\":\"f0223\",\"title\":\"Valkia the Bloody\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes\",\"number\":6,\"raw\":\"U0171 · Valkia the Bloody · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Sarah Cawkwell\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0171\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0224\",\"title\":\"Sigvald\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes\",\"number\":7,\"raw\":\"U0172 · Sigvald · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Darius Hinks\",\"year\":2011,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0172\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0225\",\"title\":\"Van Horstmann\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes\",\"number\":8,\"raw\":\"U0173 · Van Horstmann · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Ben Counter\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0173\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0226\",\"title\":\"Ghoul King: Conqueror of Worms\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes: opowiadania\",\"number\":1,\"raw\":\"1. Ghoul King: Conqueror of Worms (2013; O)       różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: 2013. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0227\",\"title\":\"Ghoul King: Empire of Maggots\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes: opowiadania\",\"number\":2,\"raw\":\"2. Ghoul King: Empire of Maggots (2013; O)        różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: 2013. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0228\",\"title\":\"The Karag Durak Grudge\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"number\":3,\"raw\":\"U0343 · The Karag Durak Grudge · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0343\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[\"Warlords of Karak Eight Peaks\"]},{\"id\":\"f0229\",\"title\":\"Bloodraven\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes: opowiadania\",\"number\":4,\"raw\":\"4. Bloodraven (?; O)                              różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0230\",\"title\":\"Blood Blessing\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes: opowiadania\",\"number\":5,\"raw\":\"5. Blood Blessing (?; O)                          różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0231\",\"title\":\"Reaper\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes: opowiadania\",\"number\":6,\"raw\":\"6. Reaper (?; O)                                  różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0232\",\"title\":\"Harbinger\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes: opowiadania\",\"number\":7,\"raw\":\"7. Harbinger (?; O)                               różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0233\",\"title\":\"Feast of Horrors\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes: opowiadania\",\"number\":8,\"raw\":\"8. Feast of Horrors (?; O)                        różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0234\",\"title\":\"Duty and Honour\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes: opowiadania\",\"number\":9,\"raw\":\"9. Duty and Honour (?; O)                         różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0235\",\"title\":\"Archaon: Everchosen\",\"pl\":\"Archaon: Wszechwybraniec\",\"series\":\"Fantasy · Archaon\",\"number\":1,\"raw\":\"U0177 · Archaon: Everchosen · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Rob Sanders\",\"year\":2014,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0177\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0236\",\"title\":\"Archaon: Lord of Chaos\",\"pl\":\"Archaon: Władca Chaosu\",\"series\":\"Fantasy · Archaon\",\"number\":2,\"raw\":\"U0178 · Archaon: Lord of Chaos · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Rob Sanders\",\"year\":2015,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0178\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0237\",\"title\":\"The Return of Nagash\",\"pl\":\"Powrót Nagasha\",\"series\":\"Fantasy · The End Times\",\"number\":1,\"raw\":\"U0179 · The Return of Nagash · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2014,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0179\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0238\",\"title\":\"The Fall of Altdorf\",\"pl\":\"Upadek Altdorfu\",\"series\":\"Fantasy · The End Times\",\"number\":2,\"raw\":\"U0180 · The Fall of Altdorf · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2014,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0180\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0239\",\"title\":\"The Curse of Khaine\",\"pl\":\"Klątwa Khaina\",\"series\":\"Fantasy · The End Times\",\"number\":3,\"raw\":\"U0181 · The Curse of Khaine · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Gav Thorpe\",\"year\":2014,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0181\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0240\",\"title\":\"The Rise of the Horned Rat\",\"pl\":\"Świt Rogatego Szczura\",\"series\":\"Fantasy · The End Times\",\"number\":4,\"raw\":\"U0182 · The Rise of the Horned Rat · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Guy Haley\",\"year\":2015,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0182\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0241\",\"title\":\"The Lord of the End Times\",\"pl\":\"Pan Końca Czasów\",\"series\":\"Fantasy · The End Times\",\"number\":5,\"raw\":\"U0183 · The Lord of the End Times · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Josh Reynolds\",\"year\":2015,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0183\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0242\",\"title\":\"Sigmar’s Blood\",\"pl\":null,\"series\":\"Fantasy · The End Times - dodatki\",\"number\":1,\"raw\":\"1. Sigmar’s Blood (2013; O)                       różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: 2013. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0243\",\"title\":\"The Bone Cage\",\"pl\":null,\"series\":\"Fantasy · The End Times - dodatki\",\"number\":2,\"raw\":\"2. The Bone Cage (2014; O)                        różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: 2014. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":2014,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0244\",\"title\":\"Marienburg’s Stand\",\"pl\":null,\"series\":\"Fantasy · The End Times - dodatki\",\"number\":3,\"raw\":\"3. Marienburg’s Stand (2015; O)                   różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: 2015. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":2015,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0245\",\"title\":\"With Ice and Sword\",\"pl\":null,\"series\":\"Fantasy · The End Times - dodatki\",\"number\":4,\"raw\":\"4. With Ice and Sword (2015; O)                   różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: 2015. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":2015,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0246\",\"title\":\"Bride of Khaine\",\"pl\":null,\"series\":\"Fantasy · The End Times - dodatki\",\"number\":5,\"raw\":\"5. Bride of Khaine (2015; O)                      różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: 2015. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":2015,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0247\",\"title\":\"The Siege of Naggarond\",\"pl\":null,\"series\":\"Fantasy · The End Times - dodatki\",\"number\":6,\"raw\":\"6. The Siege of Naggarond (2015; O)               różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: 2015. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":2015,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0248\",\"title\":\"Empire in Chaos\",\"pl\":null,\"series\":\"Fantasy · Warhammer Online\",\"number\":1,\"raw\":\"U0185 · Empire in Chaos · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2008,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0185\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0249\",\"title\":\"Dark Storm Gathering\",\"pl\":null,\"series\":\"Fantasy · Warhammer Online\",\"number\":2,\"raw\":\"U0186 · Dark Storm Gathering · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2009,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0186\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0250\",\"title\":\"Forged by Chaos\",\"pl\":null,\"series\":\"Fantasy · Warhammer Online\",\"number\":3,\"raw\":\"U0187 · Forged by Chaos · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2009,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0187\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0251\",\"title\":\"Lords of the Lance\",\"pl\":null,\"series\":\"Fantasy · The Old World - nowa linia\",\"number\":1,\"raw\":\"U0188 · Lords of the Lance · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0188\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0252\",\"title\":\"Blood of the Bastion\",\"pl\":null,\"series\":\"Fantasy · The Old World - nowa linia\",\"number\":2,\"raw\":\"U0189 · Blood of the Bastion · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0189\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0253\",\"title\":\"Zavant\",\"pl\":null,\"series\":\"Fantasy · Zavant\",\"number\":1,\"raw\":\"U0190 · Zavant · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Gordon Rennie / Josh Reynolds\",\"year\":2002,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0190\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0254\",\"title\":\"The Case of the Scarlet Cell\",\"pl\":null,\"series\":\"Fantasy · Zavant: opowiadania\",\"number\":1,\"raw\":\"1. The Case of the Scarlet Cell (?; O)            Gordon Rennie / Josh Reynolds · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: Gordon Rennie / Josh Reynolds. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"Gordon Rennie / Josh Reynolds\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0255\",\"title\":\"The Problem of Three-Toll Bridge\",\"pl\":null,\"series\":\"Fantasy · Zavant: opowiadania\",\"number\":2,\"raw\":\"2. The Problem of Three-Toll Bridge (2012; O)     Gordon Rennie / Josh Reynolds · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: 2012. Autor wg PDF: Gordon Rennie / Josh Reynolds. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"Gordon Rennie / Josh Reynolds\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0256\",\"title\":\"The Riddle of Scorpions\",\"pl\":null,\"series\":\"Fantasy · Zavant: opowiadania\",\"number\":3,\"raw\":\"3. The Riddle of Scorpions (?; O)                 Gordon Rennie / Josh Reynolds · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: Gordon Rennie / Josh Reynolds. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"Gordon Rennie / Josh Reynolds\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0257\",\"title\":\"Beneath the City of the White Wolf\",\"pl\":null,\"series\":\"Fantasy · Path to Victory - gamebooki\",\"number\":1,\"raw\":\"1. Beneath the City of the White Wolf (2012; G)           różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: 2012. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"książka paragrafowa\",\"author\":\"różni autorzy\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"G\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0258\",\"title\":\"Shadows over Sylvania\",\"pl\":null,\"series\":\"Fantasy · Path to Victory - gamebooki\",\"number\":2,\"raw\":\"2. Shadows over Sylvania (2013; G)                        różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: 2013. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"książka paragrafowa\",\"author\":\"różni autorzy\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"G\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0259\",\"title\":\"Wolf Riders\",\"pl\":null,\"series\":\"Fantasy · Antologie klasyczne (Fantasy)\",\"number\":1,\"raw\":\"U0191 · Wolf Riders · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":1989,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0191\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0260\",\"title\":\"Ignorant Armies\",\"pl\":null,\"series\":\"Fantasy · Antologie klasyczne (Fantasy)\",\"number\":2,\"raw\":\"U0192 · Ignorant Armies · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":1989,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0192\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0261\",\"title\":\"Red Thirst\",\"pl\":null,\"series\":\"Fantasy · Antologie klasyczne (Fantasy)\",\"number\":3,\"raw\":\"U0193 · Red Thirst · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":1990,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0193\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0262\",\"title\":\"Realm of Chaos\",\"pl\":null,\"series\":\"Fantasy · Antologie klasyczne (Fantasy)\",\"number\":4,\"raw\":\"U0194 · Realm of Chaos · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2000,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0194\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0263\",\"title\":\"Lords of Valour\",\"pl\":null,\"series\":\"Fantasy · Antologie klasyczne (Fantasy)\",\"number\":5,\"raw\":\"U0195 · Lords of Valour · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2001,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0195\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0264\",\"title\":\"The Laughter of Dark Gods\",\"pl\":null,\"series\":\"Fantasy · Antologie klasyczne (Fantasy)\",\"number\":6,\"raw\":\"U0196 · The Laughter of Dark Gods · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2002,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0196\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0265\",\"title\":\"Way of the Dead\",\"pl\":null,\"series\":\"Fantasy · Antologie klasyczne (Fantasy)\",\"number\":7,\"raw\":\"U0197 · Way of the Dead · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2003,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0197\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0266\",\"title\":\"Swords of the Empire\",\"pl\":null,\"series\":\"Fantasy · Antologie klasyczne (Fantasy)\",\"number\":8,\"raw\":\"U0198 · Swords of the Empire · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2004,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0198\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0267\",\"title\":\"The Cold Hand of Betrayal\",\"pl\":null,\"series\":\"Fantasy · Antologie klasyczne (Fantasy)\",\"number\":9,\"raw\":\"U0199 · The Cold Hand of Betrayal · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2006,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0199\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0268\",\"title\":\"Tales of the Old World\",\"pl\":null,\"series\":\"Fantasy · Antologie klasyczne (Fantasy)\",\"number\":10,\"raw\":\"U0200 · Tales of the Old World · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2007,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0200\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0269\",\"title\":\"Invasion!\",\"pl\":null,\"series\":\"Fantasy · Antologie klasyczne (Fantasy)\",\"number\":11,\"raw\":\"U0201 · Invasion! · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2007,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0201\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0270\",\"title\":\"Death and Dishonour\",\"pl\":null,\"series\":\"Fantasy · Antologie klasyczne (Fantasy)\",\"number\":12,\"raw\":\"U0202 · Death and Dishonour · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2010,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0202\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0271\",\"title\":\"War Unending\",\"pl\":null,\"series\":\"Fantasy · Antologie klasyczne (Fantasy)\",\"number\":13,\"raw\":\"U0203 · War Unending · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2010,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0203\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0272\",\"title\":\"Age of Legend\",\"pl\":null,\"series\":\"Fantasy · Antologie klasyczne (Fantasy)\",\"number\":14,\"raw\":\"U0204 · Age of Legend · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0204\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0273\",\"title\":\"The Best of Hammer and Bolter: Volume One\",\"pl\":null,\"series\":\"Fantasy · Antologie klasyczne (Fantasy)\",\"number\":15,\"raw\":\"U0205 · The Best of Hammer and Bolter: Volume One · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0205\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0274\",\"title\":\"The Best of Hammer and Bolter: Volume Two\",\"pl\":null,\"series\":\"Fantasy · Antologie klasyczne (Fantasy)\",\"number\":16,\"raw\":\"U0206 · The Best of Hammer and Bolter: Volume Two · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2013,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0206\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0275\",\"title\":\"The Legend of Sigmar\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Sigmar\",\"number\":1,\"raw\":\"U0137 · The Legend of Sigmar · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2017,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0137\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Heldenhammer\",\"Empire\",\"God King\",\"Let the Great Axe Fall\",\"Gods of Flesh and Blood\",\"Sword Guardian\"],\"omnibusTitles\":[]},{\"id\":\"f0276\",\"title\":\"The Rise of Nagash\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Nagash\",\"number\":2,\"raw\":\"U0141 · The Rise of Nagash · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"Mike Lee\",\"year\":2012,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0141\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Nagash the Sorcerer\",\"Nagash the Unbroken\",\"Nagash Immortal\",\"Picking the Bones\"],\"omnibusTitles\":[]},{\"id\":\"f0277\",\"title\":\"The Sundering\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Sundering\",\"number\":3,\"raw\":\"U0147 · The Sundering · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0147\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Malekith\",\"Shadow King\",\"Caledor\"],\"omnibusTitles\":[]},{\"id\":\"f0278\",\"title\":\"The War of Vengeance\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - War of Vengeance\",\"number\":4,\"raw\":\"U0155 · The War of Vengeance · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0155\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"The Great Betrayal\",\"Master of Dragons\",\"Curse of the Phoenix Crown\"],\"omnibusTitles\":[]},{\"id\":\"f0279\",\"title\":\"Skaven Wars: The Black Plague Trilogy\",\"pl\":null,\"series\":\"Fantasy · Time of Legends - Black Plague\",\"number\":5,\"raw\":\"U0151 · Skaven Wars: The Black Plague Trilogy · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0151\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Dead Winter\",\"Blighted Empire\",\"Wolf of Sigmar\",\"Plague Priest\",\"Plague Doktor\",\"A Question of Faith\",\"The Last Man\"],\"omnibusTitles\":[]},{\"id\":\"f0280\",\"title\":\"Warriors of the Chaos Wastes\",\"pl\":null,\"series\":\"Fantasy · Chaos Powers\",\"number\":6,\"raw\":\"U0082 · Warriors of the Chaos Wastes · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0082\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0281\",\"title\":\"Champions of Chaos\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes\",\"number\":7,\"raw\":\"U0176 · Champions of Chaos · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy według spisu zawartości Black Library [źródło BL]\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0176\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0282\",\"title\":\"The Empire\",\"pl\":null,\"series\":\"Fantasy · Imperium\",\"number\":8,\"raw\":\"U0100 · The Empire · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0100\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0283\",\"title\":\"Empire at War\",\"pl\":null,\"series\":\"Fantasy · Imperium\",\"number\":9,\"raw\":\"U0101 · Empire at War · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0101\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0284\",\"title\":\"Masters of Steel and Stone\",\"pl\":null,\"series\":\"Fantasy · Krasnoludy\",\"number\":10,\"raw\":\"U0089 · Masters of Steel and Stone · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0089\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Grudge Bearer\",\"Oathbreaker\",\"Honourkeeper\",\"The Doom of Dragonback\"],\"omnibusTitles\":[]},{\"id\":\"f0285\",\"title\":\"Warlords of Karak Eight Peaks\",\"pl\":null,\"series\":\"Fantasy · Krasnoludy\",\"number\":11,\"raw\":\"U0090 · Warlords of Karak Eight Peaks · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0090\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Skarsnik\",\"Headtaker\",\"Thorgrim\",\"The Karag Durak Grudge\",\"The King of Black Crag\"],\"omnibusTitles\":[]},{\"id\":\"f0286\",\"title\":\"Elves: The Omnibus\",\"pl\":null,\"series\":\"Fantasy · Elves\",\"number\":12,\"raw\":\"U0094 · Elves: The Omnibus · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji [źródło BL]\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0094\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Kinstrife\",\"Defenders of Ulthuan\",\"Sons of Ellyrion\",\"Deathmasque\",\"Guardians of the Forest\",\"Freedom’s Home or Glory’s Grave\"],\"omnibusTitles\":[]},{\"id\":\"f0287\",\"title\":\"Blackhearts: The Omnibus\",\"pl\":null,\"series\":\"Fantasy · Blackhearts\",\"number\":13,\"raw\":\"U0073 · Blackhearts: The Omnibus · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0073\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Valnir’s Bane\",\"The Broken Lance\",\"Tainted Blood\",\"Rotten Fruit\",\"Hetzau’s Follies\"],\"omnibusTitles\":[]},{\"id\":\"f0288\",\"title\":\"Vampire Wars\",\"pl\":null,\"series\":\"Fantasy · Von Carstein\",\"number\":14,\"raw\":\"U0018 · Vampire Wars · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0018\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Inheritance\",\"Dominion\",\"Retribution\"],\"omnibusTitles\":[]},{\"id\":\"f0289\",\"title\":\"Undeath Ascendant\",\"pl\":null,\"series\":\"Fantasy · Vampires\",\"number\":15,\"raw\":\"U0165 · Undeath Ascendant · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji [źródło BL]\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0165\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0290\",\"title\":\"Knights of Bretonnia\",\"pl\":null,\"series\":\"Fantasy · Bretonnia\",\"number\":16,\"raw\":\"U0108 · Knights of Bretonnia · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 4. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0108\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Knight Errant\",\"Knight of the Realm\",\"Rest Eternal\",\"Questing Knight\",\"Grail Knight\"],\"omnibusTitles\":[]},{\"id\":\"f0291\",\"title\":\"Swords of the Emperor\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes\",\"number\":17,\"raw\":\"U0174 · Swords of the Emperor · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0174\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0292\",\"title\":\"The Chronicles of Malus Darkblade: Volume One\",\"pl\":null,\"series\":\"Fantasy · Malus Darkblade\",\"number\":18,\"raw\":\"U0042 · The Chronicles of Malus Darkblade: Volume One · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0042\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"The Blood Price\",\"The Daemon’s Curse\",\"Bloodstorm\",\"Reaper of Souls\"],\"omnibusTitles\":[]},{\"id\":\"f0293\",\"title\":\"The Chronicles of Malus Darkblade: Volume Two\",\"pl\":null,\"series\":\"Fantasy · Malus Darkblade\",\"number\":19,\"raw\":\"U0043 · The Chronicles of Malus Darkblade: Volume Two · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 3. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0043\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Warpsword\",\"Lord of Ruin\",\"Deathblade\",\"Bloodwalker\"],\"omnibusTitles\":[]},{\"id\":\"f0294\",\"title\":\"War Storm\",\"pl\":null,\"series\":\"AoS · The Realmgate Wars\",\"number\":1,\"raw\":\"U0209 · War Storm · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2015,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0209\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0295\",\"title\":\"Ghal Maraz\",\"pl\":null,\"series\":\"AoS · The Realmgate Wars\",\"number\":2,\"raw\":\"U0210 · Ghal Maraz · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2015,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0210\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0296\",\"title\":\"Hammers of Sigmar\",\"pl\":null,\"series\":\"AoS · The Realmgate Wars\",\"number\":3,\"raw\":\"U0211 · Hammers of Sigmar · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2015,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0211\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0297\",\"title\":\"Call of Archaon\",\"pl\":null,\"series\":\"AoS · The Realmgate Wars\",\"number\":4,\"raw\":\"U0212 · Call of Archaon · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2015,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0212\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0298\",\"title\":\"Wardens of the Everqueen\",\"pl\":null,\"series\":\"AoS · The Realmgate Wars\",\"number\":5,\"raw\":\"U0213 · Wardens of the Everqueen · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2016,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0213\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0299\",\"title\":\"Warbeast\",\"pl\":null,\"series\":\"AoS · The Realmgate Wars\",\"number\":6,\"raw\":\"U0214 · Warbeast · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Gav Thorpe\",\"year\":2016,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0214\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0300\",\"title\":\"Fury of Gork\",\"pl\":null,\"series\":\"AoS · The Realmgate Wars\",\"number\":7,\"raw\":\"U0215 · Fury of Gork · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Josh Reynolds\",\"year\":2016,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0215\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0301\",\"title\":\"Bladestorm\",\"pl\":null,\"series\":\"AoS · The Realmgate Wars\",\"number\":8,\"raw\":\"U0216 · Bladestorm · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Matt Westbrook\",\"year\":2016,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0216\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0302\",\"title\":\"Mortarch of Night\",\"pl\":null,\"series\":\"AoS · The Realmgate Wars\",\"number\":9,\"raw\":\"U0217 · Mortarch of Night · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2016,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0217\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0303\",\"title\":\"The Gates of Azyr\",\"pl\":null,\"series\":\"AoS · The Realmgate Wars\",\"number\":1,\"raw\":\"U0208 · The Gates of Azyr · nowela · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"nowela\",\"author\":\"Chris Wraight\",\"year\":2015,\"universe\":\"Age of Sigmar\",\"publicationType\":\"N\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0208\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0304\",\"title\":\"Fyreslayers\",\"pl\":null,\"series\":\"AoS · Legends of the Age of Sigmar\",\"number\":1,\"raw\":\"U0220 · Fyreslayers · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2016,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0220\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0305\",\"title\":\"Skaven Pestilens\",\"pl\":null,\"series\":\"AoS · Legends of the Age of Sigmar\",\"number\":2,\"raw\":\"U0221 · Skaven Pestilens · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2016,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0221\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0306\",\"title\":\"Sylvaneth\",\"pl\":null,\"series\":\"AoS · Legends of the Age of Sigmar\",\"number\":3,\"raw\":\"U0222 · Sylvaneth · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2016,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0222\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0307\",\"title\":\"Black Rift\",\"pl\":null,\"series\":\"AoS · Legends of the Age of Sigmar\",\"number\":4,\"raw\":\"U0223 · Black Rift · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":2016,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0223\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0308\",\"title\":\"The Keys to Ruin\",\"pl\":null,\"series\":\"Age of Sigmar · Legends of AoS - utwory\",\"number\":1,\"raw\":\"1. The Keys to Ruin (?; O)                          różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0309\",\"title\":\"Shattered Crucible\",\"pl\":null,\"series\":\"Age of Sigmar · Legends of AoS - utwory\",\"number\":2,\"raw\":\"2. Shattered Crucible (?; O)                        różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0310\",\"title\":\"Four Thousand Days\",\"pl\":null,\"series\":\"Age of Sigmar · Legends of AoS - utwory\",\"number\":3,\"raw\":\"3. Four Thousand Days (?; O)                        różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0311\",\"title\":\"The Volturung Road\",\"pl\":null,\"series\":\"Age of Sigmar · Legends of AoS - utwory\",\"number\":4,\"raw\":\"4. The Volturung Road (?; O)                        różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0312\",\"title\":\"Skaven Pestilens\",\"pl\":null,\"series\":\"Age of Sigmar · Legends of AoS - utwory\",\"number\":5,\"raw\":\"5. Skaven Pestilens (?; O)                          różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0313\",\"title\":\"The Resolute\",\"pl\":null,\"series\":\"Age of Sigmar · Legends of AoS - utwory\",\"number\":6,\"raw\":\"6. The Resolute (?; O)                              różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0314\",\"title\":\"The Outcast\",\"pl\":null,\"series\":\"Age of Sigmar · Legends of AoS - utwory\",\"number\":7,\"raw\":\"7. The Outcast (?; O)                               różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0315\",\"title\":\"Heartwood\",\"pl\":null,\"series\":\"Age of Sigmar · Legends of AoS - utwory\",\"number\":8,\"raw\":\"8. Heartwood (?; O)                                 różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0316\",\"title\":\"The Splintered\",\"pl\":null,\"series\":\"Age of Sigmar · Legends of AoS - utwory\",\"number\":9,\"raw\":\"9. The Splintered (?; O)                            różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0317\",\"title\":\"Wrathspring\",\"pl\":null,\"series\":\"Age of Sigmar · Legends of AoS - utwory\",\"number\":10,\"raw\":\"10. Wrathspring (?; O)                              różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0318\",\"title\":\"Plague Garden\",\"pl\":\"Ogród Plagi — Błogosławieni Rycerze\",\"series\":\"AoS · Hallowed Knights\",\"number\":1,\"raw\":\"U0225 · Plague Garden · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Josh Reynolds\",\"year\":2017,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0225\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0319\",\"title\":\"Black Pyramid\",\"pl\":\"Czarna Piramida — Błogosławieni Rycerze\",\"series\":\"AoS · Hallowed Knights\",\"number\":2,\"raw\":\"U0226 · Black Pyramid · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Josh Reynolds\",\"year\":2018,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0226\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0320\",\"title\":\"City of Secrets\",\"pl\":null,\"series\":\"AoS · Callis i Toll\",\"number\":1,\"raw\":\"U0227 · City of Secrets · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nick Horth i inni\",\"year\":2017,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0227\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0321\",\"title\":\"The Silver Shard\",\"pl\":\"Callis i Toll: Srebrny Odłamek\",\"series\":\"AoS · Callis i Toll\",\"number\":2,\"raw\":\"U0228 · The Silver Shard · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nick Horth i inni\",\"year\":2018,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0228\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0322\",\"title\":\"Callis & Toll\",\"pl\":null,\"series\":\"AoS · Callis i Toll\",\"number\":3,\"raw\":\"U0229 · Callis & Toll · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Nick Horth i inni\",\"year\":2024,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0229\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0323\",\"title\":\"The Old Ways\",\"pl\":null,\"series\":\"Age of Sigmar · Callis i Toll: opowiadania\",\"number\":1,\"raw\":\"1. The Old Ways (?; O)                              Nick Horth · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: Nick Horth. Polskie wydanie niezweryfikowane.\",\"kind\":\"opowiadanie\",\"author\":\"Nick Horth\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0324\",\"title\":\"Spear of Shadows\",\"pl\":null,\"series\":\"AoS · Eight Lamentations\",\"number\":1,\"raw\":\"U0230 · Spear of Shadows · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Josh Reynolds\",\"year\":2017,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0230\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0325\",\"title\":\"The Dominion of Bones\",\"pl\":null,\"series\":\"AoS · Neferata\",\"number\":1,\"raw\":\"U0231 · The Dominion of Bones · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"David Annandale\",\"year\":2018,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0231\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0326\",\"title\":\"Ghoulslayer\",\"pl\":\"Zabójca Ghuli\",\"series\":\"AoS · Gotrek w Age of Sigmar\",\"number\":1,\"raw\":\"U0232 · Ghoulslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: Autor konkretnego utworu potwierdzony przez Copernicus Corporation; pierwotny PDF podawał autorów zbiorczo. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Darius Hinks\",\"year\":2019,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0232\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0327\",\"title\":\"Gitslayer\",\"pl\":\"Zabójca Pentaków\",\"series\":\"AoS · Gotrek w Age of Sigmar\",\"number\":2,\"raw\":\"U0233 · Gitslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: Autor konkretnego utworu potwierdzony przez Copernicus Corporation; pierwotny PDF podawał autorów zbiorczo. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Darius Hinks\",\"year\":2021,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0233\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0328\",\"title\":\"Soulslayer\",\"pl\":\"Zabójca Dusz\",\"series\":\"AoS · Gotrek w Age of Sigmar\",\"number\":3,\"raw\":\"U0234 · Soulslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: Autor konkretnego utworu potwierdzony przez Copernicus Corporation; pierwotny PDF podawał autorów zbiorczo. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Darius Hinks\",\"year\":2022,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0234\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0329\",\"title\":\"Blightslayer\",\"pl\":\"Zabójca Zarazy\",\"series\":\"AoS · Gotrek w Age of Sigmar\",\"number\":4,\"raw\":\"U0235 · Blightslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: Autor konkretnego utworu potwierdzony przez Copernicus Corporation; pierwotny PDF podawał autorów zbiorczo. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Richard Strachan\",\"year\":2023,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0235\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0330\",\"title\":\"Verminslayer\",\"pl\":\"Zabójca Szkodników\",\"series\":\"AoS · Gotrek w Age of Sigmar\",\"number\":5,\"raw\":\"U0236 · Verminslayer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Darius Hinks / Richard Strachan i inni\",\"year\":2025,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0236\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0331\",\"title\":\"Realmslayer\",\"pl\":null,\"series\":\"Age of Sigmar · Gotrek AoS - słuchowiska / proza\",\"number\":1,\"raw\":\"1. Realmslayer (2018; Z)                          David Guymer i inni · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: 2018. Autor wg PDF: David Guymer i inni. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"omnibus\",\"author\":\"David Guymer i inni\",\"year\":2018,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0332\",\"title\":\"Blood of the Old World\",\"pl\":null,\"series\":\"Age of Sigmar · Gotrek AoS - słuchowiska / proza\",\"number\":2,\"raw\":\"2. Blood of the Old World (2019; Z)               David Guymer i inni · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: 2019. Autor wg PDF: David Guymer i inni. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"omnibus\",\"author\":\"David Guymer i inni\",\"year\":2019,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0333\",\"title\":\"Realmslayer: Legend of the Doomseeker\",\"pl\":null,\"series\":\"AoS · Gotrek w Age of Sigmar\",\"number\":3,\"raw\":\"U0237 · Realmslayer: Legend of the Doomseeker · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"David Guymer i inni\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0237\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0334\",\"title\":\"Gotrek and Maleneth: The Omnibus\",\"pl\":null,\"series\":\"AoS · Gotrek w Age of Sigmar\",\"number\":4,\"raw\":\"U0238 · Gotrek and Maleneth: The Omnibus · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"David Guymer i inni\",\"year\":2025,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0238\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0335\",\"title\":\"Soul Wars\",\"pl\":\"Wojny Dusz\",\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":1,\"raw\":\"U0240 · Soul Wars · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Josh Reynolds\",\"year\":2018,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0240\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0336\",\"title\":\"Gloomspite\",\"pl\":\"W blasku Złego Księżyca\",\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":2,\"raw\":\"U0241 · Gloomspite · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Andy Clark\",\"year\":2019,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0241\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0337\",\"title\":\"Cursed City\",\"pl\":\"Przeklęte Miasto\",\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":3,\"raw\":\"U0242 · Cursed City · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2021,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0242\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0338\",\"title\":\"Dominion\",\"pl\":\"Dominium\",\"series\":\"Age of Sigmar · AoS: powieści i nowele A\",\"number\":4,\"raw\":\"4. Dominion (2021; P)                             różni autorzy · PL potw.: Dominium\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: 2021. Autor wg PDF: różni autorzy. Polskie wydanie potwierdzone w zestawieniu. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"powieść\",\"author\":\"różni autorzy\",\"year\":2021,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"potwierdzone\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0339\",\"title\":\"Godeater’s Son\",\"pl\":\"Syn Bogożercy\",\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":5,\"raw\":\"U0243 · Godeater’s Son · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Noah Van Nguyen\",\"year\":2023,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0243\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0340\",\"title\":\"Overlords of the Iron Dragon\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":6,\"raw\":\"U0244 · Overlords of the Iron Dragon · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2017,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0244\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0341\",\"title\":\"The Court of the Blind King\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":7,\"raw\":\"U0245 · The Court of the Blind King · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2019,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0245\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0342\",\"title\":\"The Arkanaut’s Oath\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":8,\"raw\":\"U0246 · The Arkanaut’s Oath · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Guy Haley\",\"year\":2022,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0246\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0343\",\"title\":\"The Ghosts of Barak-Minoz\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":9,\"raw\":\"U0247 · The Ghosts of Barak-Minoz · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2024,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0247\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0344\",\"title\":\"Profit’s Ruin\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":10,\"raw\":\"U0248 · Profit’s Ruin · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":2020,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0248\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0345\",\"title\":\"Children of Teclis\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":11,\"raw\":\"U0249 · Children of Teclis · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2023,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0249\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0346\",\"title\":\"The Last Volari\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":12,\"raw\":\"U0250 · The Last Volari · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2023,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0250\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0347\",\"title\":\"Grombrindal: Chronicles of the Wanderer\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":1,\"raw\":\"U0251 · Grombrindal: Chronicles of the Wanderer · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2022,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0251\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0348\",\"title\":\"Grombrindal: Ancestor’s Burden\",\"pl\":null,\"series\":\"AoS · Pozostałe antologie i omnibusy (Age of Sigmar)\",\"number\":2,\"raw\":\"U0311 · Grombrindal: Ancestor’s Burden · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"Chris Thursten\",\"year\":2025,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0311\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Rat-Tail\",\"High Airs\",\"Durkar's Wake\",\"King Osgek's Prize\",\"No God's Land\",\"Bitter Oaths\",\"The Maker's Promise\"],\"omnibusTitles\":[]},{\"id\":\"f0349\",\"title\":\"Gothghul Hollow\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":3,\"raw\":\"U0252 · Gothghul Hollow · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2022,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0252\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0350\",\"title\":\"The Hollow King\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":4,\"raw\":\"U0253 · The Hollow King · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2022,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0253\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0351\",\"title\":\"The Vulture Lord\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":5,\"raw\":\"U0254 · The Vulture Lord · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2022,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0254\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0352\",\"title\":\"Prince Maesa\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":6,\"raw\":\"U0255 · Prince Maesa · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2022,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0255\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0353\",\"title\":\"Godsbane\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":7,\"raw\":\"U0256 · Godsbane · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2022,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0256\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0354\",\"title\":\"Hallowed Ground\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":8,\"raw\":\"U0257 · Hallowed Ground · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2022,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0257\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0355\",\"title\":\"Kragnos: Avatar of Destruction\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":9,\"raw\":\"U0258 · Kragnos: Avatar of Destruction · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2021,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0258\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0356\",\"title\":\"A Dynasty of Monsters\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":10,\"raw\":\"U0259 · A Dynasty of Monsters · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2021,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0259\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0357\",\"title\":\"The End of Enlightenment\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":11,\"raw\":\"U0260 · The End of Enlightenment · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2020,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0260\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0358\",\"title\":\"Stormvault\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":12,\"raw\":\"U0261 · Stormvault · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2019,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0261\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0359\",\"title\":\"Covens of Blood\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":13,\"raw\":\"U0262 · Covens of Blood · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2020,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0262\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0360\",\"title\":\"Realm-Lords\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":14,\"raw\":\"U0263 · Realm-Lords · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2020,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0263\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0361\",\"title\":\"Lady of Sorrows\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":15,\"raw\":\"U0264 · Lady of Sorrows · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2020,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0264\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0362\",\"title\":\"Beastgrave\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":16,\"raw\":\"U0265 · Beastgrave · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2019,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0265\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0363\",\"title\":\"Shadespire: The Mirrored City\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":17,\"raw\":\"U0266 · Shadespire: The Mirrored City · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2018,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0266\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0364\",\"title\":\"Skaventide\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":1,\"raw\":\"U0267 · Skaventide · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2024,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0267\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0365\",\"title\":\"Darkoath\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":2,\"raw\":\"U0268 · Darkoath · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2024,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0268\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0366\",\"title\":\"The Dead Kingdom\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":3,\"raw\":\"U0269 · The Dead Kingdom · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2024,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0269\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0367\",\"title\":\"Blacktalon\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":4,\"raw\":\"U0270 · Blacktalon · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"Liane Merciel\",\"year\":2024,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0270\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0368\",\"title\":\"Temple of Silence\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":5,\"raw\":\"U0271 · Temple of Silence · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2024,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0271\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0369\",\"title\":\"Yndrasta: The Celestial Spear\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":6,\"raw\":\"U0272 · Yndrasta: The Celestial Spear · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2023,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0272\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0370\",\"title\":\"Lioness of the Parch\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":7,\"raw\":\"U0273 · Lioness of the Parch · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2024,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0273\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0371\",\"title\":\"Shade of Khaine\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":8,\"raw\":\"U0274 · Shade of Khaine · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0274\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0372\",\"title\":\"Queen of the Rose Throne\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":9,\"raw\":\"U0275 · Queen of the Rose Throne · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0275\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0373\",\"title\":\"Ushoran: Mortarch of Delusion\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":10,\"raw\":\"U0276 · Ushoran: Mortarch of Delusion · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0276\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0374\",\"title\":\"Starseer’s Ruin\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":11,\"raw\":\"U0277 · Starseer’s Ruin · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0277\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0375\",\"title\":\"Abraxia: Spear of the Everchosen\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":12,\"raw\":\"U0278 · Abraxia: Spear of the Everchosen · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0278\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0376\",\"title\":\"First Marshal\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":13,\"raw\":\"U0279 · First Marshal · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0279\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0377\",\"title\":\"Soulblight Gravelords: Masters of Death\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":14,\"raw\":\"U0280 · Soulblight Gravelords: Masters of Death · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0280\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0378\",\"title\":\"Anvils of the Heldenhammer: The Ancients\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":15,\"raw\":\"U0281 · Anvils of the Heldenhammer: The Ancients · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0281\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0379\",\"title\":\"Hammers of Sigmar: First Forged\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":16,\"raw\":\"U0282 · Hammers of Sigmar: First Forged · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2023,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0282\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0380\",\"title\":\"Bad Loon Rising\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":17,\"raw\":\"U0283 · Bad Loon Rising · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":2023,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0283\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0381\",\"title\":\"War for the Mortal Realms\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: powieści i nowele C\",\"number\":18,\"raw\":\"18. War for the Mortal Realms (?; P)                  różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"powieść\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0382\",\"title\":\"Untamed Realms\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":19,\"raw\":\"U0284 · Untamed Realms · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0284\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0383\",\"title\":\"The Crown of Karak-Khazhar\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: powieści i nowele C\",\"number\":20,\"raw\":\"20. The Crown of Karak-Khazhar (?; P)                 różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"powieść\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0384\",\"title\":\"Zograt\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: powieści i nowele C\",\"number\":21,\"raw\":\"21. Zograt (?; P)                                     różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa. Wyłączone z wykazu samodzielnych książek fizycznych w aktualizacji z 12.10.2026; zachowano rekord dla istniejącej kolekcji i wyników.\",\"kind\":\"powieść\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowane\",\"catalogMarker\":\"wyłączone_z_wykazu_fizycznych\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0385\",\"title\":\"City of Secrets\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: inne powieści\",\"number\":1,\"raw\":\"1. City of Secrets (?; P)                         różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"powieść\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0386\",\"title\":\"The Red Feast\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":2,\"raw\":\"U0285 · The Red Feast · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0285\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0387\",\"title\":\"Harrowdeep\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":3,\"raw\":\"U0286 · Harrowdeep · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0286\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0388\",\"title\":\"The Siege of Greenspire\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: inne powieści\",\"number\":4,\"raw\":\"4. The Siege of Greenspire (?; P)                 różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa. Wyłączone z wykazu samodzielnych książek fizycznych w aktualizacji z 12.10.2026; zachowano rekord dla istniejącej kolekcji i wyników.\",\"kind\":\"powieść\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowane\",\"catalogMarker\":\"wyłączone_z_wykazu_fizycznych\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0389\",\"title\":\"The Undying King\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":5,\"raw\":\"U0287 · The Undying King · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0287\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0390\",\"title\":\"Blacktalon: First Mark\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":6,\"raw\":\"U0288 · Blacktalon: First Mark · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0288\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0391\",\"title\":\"The Tainted Heart\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":7,\"raw\":\"U0289 · The Tainted Heart · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0289\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0392\",\"title\":\"The Silver Shard\",\"pl\":\"Callis i Toll: Srebrny Odłamek\",\"series\":\"Age of Sigmar · AoS: inne powieści\",\"number\":8,\"raw\":\"8. The Silver Shard (2018; P)                        Nick Horth i inni · PL potw.: Callis i Toll: Srebrny Odłamek\",\"uncertain\":true,\"note\":\"Wydanie z 2018 r. i polski druk: Callis i Toll: Srebrny Odłamek, według wykazu z 12.10.2026. Autorzy podani zbiorowo w źródle; szczegóły do weryfikacji.\",\"kind\":\"powieść\",\"author\":\"Nick Horth i inni\",\"year\":2018,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"potwierdzone\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0393\",\"title\":\"The Spear of Shadows\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: inne powieści\",\"number\":9,\"raw\":\"9. The Spear of Shadows (?; P)                    różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"powieść\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0394\",\"title\":\"The Bone Desert\",\"pl\":null,\"series\":\"AoS · Gotrek w Age of Sigmar\",\"number\":10,\"raw\":\"U0239 · The Bone Desert · nowela · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"nowela\",\"author\":\"Robbie MacNiven\",\"year\":2018,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0239\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0395\",\"title\":\"Dark Harvest\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":11,\"raw\":\"U0290 · Dark Harvest · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0290\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0396\",\"title\":\"The Harrowed Paths\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: inne powieści\",\"number\":12,\"raw\":\"12. The Harrowed Paths (?; P)                     różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"powieść\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0397\",\"title\":\"The Measure of Iron\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":13,\"raw\":\"U0291 · The Measure of Iron · nowela · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"nowela\",\"author\":\"Jamie Crisalli\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"N\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0291\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0398\",\"title\":\"The Last Knight\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":14,\"raw\":\"U0292 · The Last Knight · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0292\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0399\",\"title\":\"Castle of Blood\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":15,\"raw\":\"U0293 · Castle of Blood · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 9. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0293\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0400\",\"title\":\"Blood of the Flayer\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: inne powieści\",\"number\":16,\"raw\":\"16. Blood of the Flayer (?; P)                    różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa. Wyłączone z wykazu samodzielnych książek fizycznych w aktualizacji z 12.10.2026; zachowano rekord dla istniejącej kolekcji i wyników.\",\"kind\":\"powieść\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowane\",\"catalogMarker\":\"wyłączone_z_wykazu_fizycznych\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0401\",\"title\":\"Warqueen\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":17,\"raw\":\"U0294 · Warqueen · nowela · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"nowela\",\"author\":\"autor do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0294\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0402\",\"title\":\"Legends of the Age of Sigmar: Omnibus 1\",\"pl\":null,\"series\":\"AoS · Legends of the Age of Sigmar\",\"number\":1,\"raw\":\"U0224 · Legends of the Age of Sigmar: Omnibus 1 · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0224\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0403\",\"title\":\"Gods and Mortals\",\"pl\":null,\"series\":\"AoS · Pozostałe antologie i omnibusy (Age of Sigmar)\",\"number\":2,\"raw\":\"U0297 · Gods and Mortals · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0297\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0404\",\"title\":\"Hammerhal & Other Stories\",\"pl\":null,\"series\":\"AoS · Pozostałe antologie i omnibusy (Age of Sigmar)\",\"number\":3,\"raw\":\"U0298 · Hammerhal & Other Stories · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0298\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0405\",\"title\":\"Sacrosanct & Other Stories\",\"pl\":null,\"series\":\"AoS · Pozostałe antologie i omnibusy (Age of Sigmar)\",\"number\":4,\"raw\":\"U0299 · Sacrosanct & Other Stories · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0299\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0406\",\"title\":\"The Hammer and the Eagle\",\"pl\":null,\"series\":\"AoS · Pozostałe antologie i omnibusy (Age of Sigmar)\",\"number\":5,\"raw\":\"U0300 · The Hammer and the Eagle · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0300\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0407\",\"title\":\"Conquest Unbound: Stories from the Mortal Realms\",\"pl\":null,\"series\":\"AoS · Pozostałe antologie i omnibusy (Age of Sigmar)\",\"number\":6,\"raw\":\"U0301 · Conquest Unbound: Stories from the Mortal Realms · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0301\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0408\",\"title\":\"On the Shoulders of Giants and Other Stories\",\"pl\":null,\"series\":\"AoS · Pozostałe antologie i omnibusy (Age of Sigmar)\",\"number\":7,\"raw\":\"U0302 · On the Shoulders of Giants and Other Stories · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0302\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0409\",\"title\":\"Thunderstrike & Other Stories\",\"pl\":null,\"series\":\"AoS · Pozostałe antologie i omnibusy (Age of Sigmar)\",\"number\":8,\"raw\":\"U0303 · Thunderstrike & Other Stories · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0303\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0410\",\"title\":\"The Harrowed Paths\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: antologie i omnibusy\",\"number\":9,\"raw\":\"9. The Harrowed Paths (?; Z)                                           redaktorzy: różni · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: redaktorzy: różni. Polskie wydanie niezweryfikowane.\",\"kind\":\"omnibus\",\"author\":\"redaktorzy: różni\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0411\",\"title\":\"Warriors of the Freeguilds\",\"pl\":null,\"series\":\"AoS · Pozostałe antologie i omnibusy (Age of Sigmar)\",\"number\":10,\"raw\":\"U0304 · Warriors of the Freeguilds · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0304\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0412\",\"title\":\"War for the Mortal Realms\",\"pl\":null,\"series\":\"AoS · Pozostałe antologie i omnibusy (Age of Sigmar)\",\"number\":11,\"raw\":\"U0305 · War for the Mortal Realms · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0305\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0413\",\"title\":\"Inferno! An Age of Sigmar Collection\",\"pl\":null,\"series\":\"AoS · Pozostałe antologie i omnibusy (Age of Sigmar)\",\"number\":12,\"raw\":\"U0306 · Inferno! An Age of Sigmar Collection · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0306\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0414\",\"title\":\"Inferno! Presents: The Emperor’s Finest and Other Stories\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: antologie i omnibusy\",\"number\":13,\"raw\":\"13. Inferno! Presents: The Emperor’s Finest and Other Stories (?; Z)   redaktorzy: różni · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: redaktorzy: różni. Polskie wydanie niezweryfikowane. Wyłączone z wykazu samodzielnych książek fizycznych w aktualizacji z 12.10.2026; zachowano rekord dla istniejącej kolekcji i wyników.\",\"kind\":\"omnibus\",\"author\":\"redaktorzy: różni\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowane\",\"catalogMarker\":\"wyłączone_z_wykazu_fizycznych\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0415\",\"title\":\"Black Library Novella Series 3 Collection\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: antologie i omnibusy\",\"number\":14,\"raw\":\"14. Black Library Novella Series 3 Collection (?; Z)                   redaktorzy: różni · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: redaktorzy: różni. Polskie wydanie niezweryfikowane. Wyłączone z wykazu samodzielnych książek fizycznych w aktualizacji z 12.10.2026; zachowano rekord dla istniejącej kolekcji i wyników.\",\"kind\":\"omnibus\",\"author\":\"redaktorzy: różni\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowane\",\"catalogMarker\":\"wyłączone_z_wykazu_fizycznych\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0416\",\"title\":\"Champions of the Mortal Realms\",\"pl\":null,\"series\":\"AoS · Pozostałe antologie i omnibusy (Age of Sigmar)\",\"number\":15,\"raw\":\"U0307 · Champions of the Mortal Realms · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0307\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0417\",\"title\":\"The Realm of Beasts\",\"pl\":null,\"series\":\"AoS · Pozostałe antologie i omnibusy (Age of Sigmar)\",\"number\":16,\"raw\":\"U0308 · The Realm of Beasts · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0308\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0418\",\"title\":\"The Realm of Death\",\"pl\":null,\"series\":\"AoS · Pozostałe antologie i omnibusy (Age of Sigmar)\",\"number\":17,\"raw\":\"U0309 · The Realm of Death · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy/redakcja do weryfikacji\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0309\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0419\",\"title\":\"The Dance of the Skulls\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":1,\"raw\":\"1. The Dance of the Skulls (?; O)                 różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0420\",\"title\":\"Obsidian\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":2,\"raw\":\"2. Obsidian (?; O)                                różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0421\",\"title\":\"Blacktalon: Hunting Shadows\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":3,\"raw\":\"3. Blacktalon: Hunting Shadows (?; O)             różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0422\",\"title\":\"Vault of Souls\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":4,\"raw\":\"4. Vault of Souls (?; O)                          różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0423\",\"title\":\"Bear Eater\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":5,\"raw\":\"5. Bear Eater (?; O)                              różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0424\",\"title\":\"Force of Personality\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":6,\"raw\":\"6. Force of Personality (?; O)                    różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0425\",\"title\":\"Gods’ Gift\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":7,\"raw\":\"7. Gods’ Gift (?; O)                              różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0426\",\"title\":\"The Hardest Word\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":8,\"raw\":\"8. The Hardest Word (?; O)                        różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0427\",\"title\":\"Pantheon\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":9,\"raw\":\"9. Pantheon (?; O)                                różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0428\",\"title\":\"Pilgrim’s Trial\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":10,\"raw\":\"10. Pilgrim’s Trial (?; O)                        różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0429\",\"title\":\"Auction of Blood\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":11,\"raw\":\"11. Auction of Blood (?; O)                       różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0430\",\"title\":\"Eight Lamentations: The Tainted Axe\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":12,\"raw\":\"12. Eight Lamentations: The Tainted Axe (?; O)    różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0431\",\"title\":\"The Library of Forgotten Moments\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":13,\"raw\":\"13. The Library of Forgotten Moments (?; O)       różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0432\",\"title\":\"Order of the Fly: Tourney of Fate\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":14,\"raw\":\"14. Order of the Fly: Tourney of Fate (?; O)      różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0433\",\"title\":\"The Road of Blades\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":15,\"raw\":\"15. The Road of Blades (?; O)                     różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0434\",\"title\":\"Gravesend Gold\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":16,\"raw\":\"16. Gravesend Gold (?; O)                         różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0435\",\"title\":\"The Witch Takers\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":17,\"raw\":\"17. The Witch Takers (?; O)                       różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0436\",\"title\":\"Great Red\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":18,\"raw\":\"18. Great Red (?; O)                              różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0437\",\"title\":\"The Sands of Grief\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":19,\"raw\":\"19. The Sands of Grief (?; O)                     różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0438\",\"title\":\"A Dirge of Dust and Steel\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":20,\"raw\":\"20. A Dirge of Dust and Steel (?; O)              różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0439\",\"title\":\"The Prisoner of the Black Sun\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":21,\"raw\":\"21. The Prisoner of the Black Sun (?; O)          różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0440\",\"title\":\"Shiprats\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania z antologii\",\"number\":22,\"raw\":\"22. Shiprats (?; O)                               różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0441\",\"title\":\"This Rough Beast\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":1,\"raw\":\"1. This Rough Beast (?; O)                              różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0442\",\"title\":\"Vipers of the Marsh\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":2,\"raw\":\"2. Vipers of the Marsh (?; O)                           różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0443\",\"title\":\"Reclaimed Honour\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":3,\"raw\":\"3. Reclaimed Honour (?; O)                              różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0444\",\"title\":\"Conn Crowhand’s Last Oath\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":4,\"raw\":\"4. Conn Crowhand’s Last Oath (?; O)                     różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0445\",\"title\":\"Slinktalon\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":5,\"raw\":\"5. Slinktalon (?; O)                                    różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0446\",\"title\":\"The Reservoir of Rot\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":6,\"raw\":\"6. The Reservoir of Rot (?; O)                          różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0447\",\"title\":\"A Point of Pride\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":7,\"raw\":\"7. A Point of Pride (?; O)                              różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0448\",\"title\":\"Shallow Pockets, Deep Waters\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":8,\"raw\":\"8. Shallow Pockets, Deep Waters (?; O)                  różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0449\",\"title\":\"The Rose of Bhaskar\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":9,\"raw\":\"9. The Rose of Bhaskar (?; O)                           różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0450\",\"title\":\"Doomwheel\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":10,\"raw\":\"10. Doomwheel (?; O)                                    różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0451\",\"title\":\"Da Stink of Defeat\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":11,\"raw\":\"11. Da Stink of Defeat (?; O)                           różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0452\",\"title\":\"Written in Stars\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":12,\"raw\":\"12. Written in Stars (?; O)                             różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0453\",\"title\":\"Sigmar’s Fist\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":13,\"raw\":\"13. Sigmar’s Fist (?; O)                                różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0454\",\"title\":\"The Nameless\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":14,\"raw\":\"14. The Nameless (?; O)                                 różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0455\",\"title\":\"Hounds\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":15,\"raw\":\"15. Hounds (?; O)                                       różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0456\",\"title\":\"The Wayward Tale\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":16,\"raw\":\"16. The Wayward Tale (?; O)                             różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0457\",\"title\":\"All is Foretold\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":17,\"raw\":\"17. All is Foretold (?; O)                              różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0458\",\"title\":\"The Beast of Grey Gardens\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":18,\"raw\":\"18. The Beast of Grey Gardens (?; O)                    różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0459\",\"title\":\"Cannibal Gate: The Road of the Hollow King\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":19,\"raw\":\"19. Cannibal Gate: The Road of the Hollow King (?; O)   różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0460\",\"title\":\"Murder by Moonlight\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":20,\"raw\":\"20. Murder by Moonlight (?; O)                          różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0461\",\"title\":\"The Abominations of Kriik Weirdpaw\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":21,\"raw\":\"21. The Abominations of Kriik Weirdpaw (?; O)           różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0462\",\"title\":\"Of Blood and Guts\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":22,\"raw\":\"22. Of Blood and Guts (?; O)                            różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0463\",\"title\":\"The Thorn Mile\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":23,\"raw\":\"23. The Thorn Mile (?; O)                               różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0464\",\"title\":\"Krakenbane’s Curse\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":24,\"raw\":\"24. Krakenbane’s Curse (?; O)                           różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0465\",\"title\":\"The Eyeless Mask\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":25,\"raw\":\"25. The Eyeless Mask (?; O)                             różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0466\",\"title\":\"False Dawn\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":26,\"raw\":\"26. False Dawn (?; O)                                   różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0467\",\"title\":\"Grimnirsson\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":27,\"raw\":\"27. Grimnirsson (?; O)                            różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0468\",\"title\":\"Heir of Shadows\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":28,\"raw\":\"28. Heir of Shadows (?; O)                        różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0469\",\"title\":\"Past Returns\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":29,\"raw\":\"29. Past Returns (?; O)                           różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0470\",\"title\":\"The Road to Helsmarch\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":30,\"raw\":\"30. The Road to Helsmarch (?; O)                  różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0471\",\"title\":\"The Long Run\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":31,\"raw\":\"31. The Long Run (?; O)                           różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0472\",\"title\":\"Harrowhand\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":32,\"raw\":\"32. Harrowhand (?; O)                             różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0473\",\"title\":\"Shadowglass Creek\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":33,\"raw\":\"33. Shadowglass Creek (?; O)                      różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0474\",\"title\":\"The Waste, the Worm, and the Witch\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":34,\"raw\":\"34. The Waste, the Worm, and the Witch (?; O)     różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0475\",\"title\":\"Boss of Bosses\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":35,\"raw\":\"35. Boss of Bosses (?; O)                         różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0476\",\"title\":\"The Ancestors’ Hall\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":36,\"raw\":\"36. The Ancestors’ Hall (?; O)                    różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0477\",\"title\":\"The Orphan of Pale Harbour\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":37,\"raw\":\"37. The Orphan of Pale Harbour (?; O)             różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0478\",\"title\":\"Anger and Ash\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 1\",\"number\":38,\"raw\":\"38. Anger and Ash (?; O)                          różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0479\",\"title\":\"The Resolute\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 2\",\"number\":1,\"raw\":\"1. The Resolute (?; O)                            różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0480\",\"title\":\"The Outcast\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 2\",\"number\":2,\"raw\":\"2. The Outcast (?; O)                             różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0481\",\"title\":\"The Splintered\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 2\",\"number\":3,\"raw\":\"3. The Splintered (?; O)                          różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0482\",\"title\":\"Wrathspring\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 2\",\"number\":4,\"raw\":\"4. Wrathspring (?; O)                             różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0483\",\"title\":\"Four Thousand Days\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 2\",\"number\":5,\"raw\":\"5. Four Thousand Days (?; O)                      różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0484\",\"title\":\"The Volturung Road\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 2\",\"number\":6,\"raw\":\"6. The Volturung Road (?; O)                      różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0485\",\"title\":\"Heartwood\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 2\",\"number\":7,\"raw\":\"7. Heartwood (?; O)                               różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0486\",\"title\":\"Shattered Crucible\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 2\",\"number\":8,\"raw\":\"8. Shattered Crucible (?; O)                      różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0487\",\"title\":\"The Keys to Ruin\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 2\",\"number\":9,\"raw\":\"9. The Keys to Ruin (?; O)                        różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0488\",\"title\":\"The Tainted Axe\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 2\",\"number\":10,\"raw\":\"10. The Tainted Axe (?; O)                        różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0489\",\"title\":\"The Old Ways\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 2\",\"number\":11,\"raw\":\"11. The Old Ways (?; O)                           różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0490\",\"title\":\"The Sands of Grief\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 2\",\"number\":12,\"raw\":\"12. The Sands of Grief (?; O)                     różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0491\",\"title\":\"Shiprats\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 2\",\"number\":13,\"raw\":\"13. Shiprats (?; O)                               różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0492\",\"title\":\"The Witch Takers\",\"pl\":null,\"series\":\"Age of Sigmar · AoS: opowiadania - Quick Reads 2\",\"number\":14,\"raw\":\"14. The Witch Takers (?; O)                       różni autorzy · PL: niezweryfikowane\",\"uncertain\":true,\"note\":\"Pierwsze wydanie: niepotwierdzone. Autor wg PDF: różni autorzy. Polskie wydanie niezweryfikowane. Autor konkretnego tekstu wymaga potwierdzenia; określenie grupowe z PDF nie oznacza współautorstwa.\",\"kind\":\"opowiadanie\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"O\",\"sourceStatus\":\"niezweryfikowane\",\"catalogCurrent\":false,\"contentsCoverageVerified\":false},{\"id\":\"f0493\",\"title\":\"Gotrek & Felix: The Sixth Omnibus\",\"pl\":null,\"series\":\"Fantasy · Gotrek i Felix (Stary Świat)\",\"number\":9,\"raw\":\"U0035 · Gotrek & Felix: The Sixth Omnibus · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 2. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"David Guymer [źródło BL]\",\"year\":2021,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0035\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"City of the Damned\",\"Kinslayer\",\"Slayer\",\"Rememberers\"],\"omnibusTitles\":[]},{\"id\":\"f0494\",\"title\":\"Warhammer Chronicles: The Orion Trilogy\",\"pl\":null,\"series\":\"Fantasy · Orion\",\"number\":4,\"raw\":\"U0119 · Warhammer Chronicles: The Orion Trilogy · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 5. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy według spisu zawartości Black\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0119\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Orion: The Vaults of Winter\",\"Orion: Tears of Isha\",\"Orion: The Council of Beasts\"],\"omnibusTitles\":[]},{\"id\":\"f0495\",\"title\":\"The Tyrion and Teclis Omnibus\",\"pl\":null,\"series\":\"Fantasy · Tyrion i Teclis\",\"number\":4,\"raw\":\"U0161 · The Tyrion and Teclis Omnibus · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy według spisu zawartości Black Library [źródło\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0161\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[\"Blood of Aenarion\",\"Sword of Caledor\",\"Bane of Malekith\"],\"omnibusTitles\":[]},{\"id\":\"f0496\",\"title\":\"The Red Duke\",\"pl\":null,\"series\":\"Fantasy · Vampires\",\"number\":3,\"raw\":\"U0164 · The Red Duke · powieść · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"powieść\",\"author\":\"C. L. Werner\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"P\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0164\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0497\",\"title\":\"Heroes of the Empire\",\"pl\":null,\"series\":\"Fantasy · Warhammer Heroes\",\"number\":9,\"raw\":\"U0175 · Heroes of the Empire · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 6. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy według spisu zawartości Black Library [źródło BL]\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0175\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0498\",\"title\":\"The End Times: Doom of the Old World\",\"pl\":null,\"series\":\"Fantasy · The End Times\",\"number\":6,\"raw\":\"U0184 · The End Times: Doom of the Old World · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 7. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"autorzy według spisu zawartości Black Library\",\"year\":null,\"universe\":\"Fantasy\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0184\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0499\",\"title\":\"The Realmgate Wars: Volume 1\",\"pl\":null,\"series\":\"AoS · The Realmgate Wars\",\"number\":1,\"raw\":\"U0218 · The Realmgate Wars: Volume 1 · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0218\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0500\",\"title\":\"The Realmgate Wars: Volume 2\",\"pl\":null,\"series\":\"AoS · The Realmgate Wars\",\"number\":2,\"raw\":\"U0219 · The Realmgate Wars: Volume 2 · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 8. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"różni autorzy\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0219\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0501\",\"title\":\"Heart of Winter\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":1,\"raw\":\"U0295 · Heart of Winter · nowela · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"nowela\",\"author\":\"Nick Horth\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"N\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0295\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0502\",\"title\":\"The Red Hours\",\"pl\":null,\"series\":\"AoS · Age of Sigmar - utwory samodzielne i krótkie\",\"number\":2,\"raw\":\"U0296 · The Red Hours · nowela · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"nowela\",\"author\":\"Evan Dicken\",\"year\":null,\"universe\":\"Age of Sigmar\",\"publicationType\":\"N\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0296\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0503\",\"title\":\"Myths & Revenants\",\"pl\":null,\"series\":\"AoS · Pozostałe antologie i omnibusy (Age of Sigmar)\",\"number\":18,\"raw\":\"U0310 · Myths & Revenants · zbiór / omnibus · niezweryfikowany samodzielny druk\",\"uncertain\":true,\"note\":\"niezweryfikowany samodzielny druk. Uwagi źródłowe: 10. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"kind\":\"omnibus\",\"author\":\"różni autorzy\",\"year\":2019,\"universe\":\"Age of Sigmar\",\"publicationType\":\"Z\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0310\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"contents\":[],\"omnibusTitles\":[]},{\"id\":\"f0504\",\"number\":null,\"title\":\"Slayer of the Storm God\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0325\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"raw\":\"U0325 · Slayer of the Storm God · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"uncertain\":true,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: Fourth Omnibus\"]},{\"id\":\"f0505\",\"number\":null,\"title\":\"Curse of the Everliving\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0337\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"raw\":\"U0337 · Curse of the Everliving · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"uncertain\":true,\"contents\":[],\"omnibusTitles\":[\"Gotrek and Felix: The Fifth Omnibus\"]},{\"id\":\"f0506\",\"number\":null,\"title\":\"The Doom of Dragonback\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"author\":\"Gav Thorpe\",\"year\":null,\"universe\":\"Fantasy\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0339\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"raw\":\"U0339 · The Doom of Dragonback · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"uncertain\":true,\"contents\":[],\"omnibusTitles\":[\"Masters of Steel and Stone\"]},{\"id\":\"f0507\",\"number\":null,\"title\":\"Thorgrim\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0342\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"raw\":\"U0342 · Thorgrim · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"uncertain\":true,\"contents\":[],\"omnibusTitles\":[\"Warlords of Karak Eight Peaks\"]},{\"id\":\"f0508\",\"number\":null,\"title\":\"The King of Black Crag\",\"pl\":null,\"series\":\"Fantasy · Zawartość omnibusów\",\"author\":\"do weryfikacji\",\"year\":null,\"universe\":\"Fantasy\",\"kind\":\"opowiadanie / utwór do sprawdzenia\",\"sourceStatus\":\"niezweryfikowany samodzielny druk\",\"workId\":\"U0344\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"raw\":\"U0344 · The King of Black Crag · opowiadanie / utwór do sprawdzenia · niezweryfikowany samodzielny druk\",\"note\":\"niezweryfikowany samodzielny druk. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"uncertain\":true,\"contents\":[],\"omnibusTitles\":[\"Warlords of Karak Eight Peaks\"]},{\"id\":\"f0509\",\"number\":null,\"title\":\"Rat-Tail\",\"pl\":null,\"series\":\"AoS · Grombrindal\",\"author\":\"Chris Thursten\",\"year\":null,\"universe\":\"Age of Sigmar\",\"kind\":\"opowiadanie\",\"sourceStatus\":\"samodzielny druk niepotwierdzony\",\"workId\":\"U0355\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"raw\":\"U0355 · Rat-Tail · opowiadanie · samodzielny druk niepotwierdzony\",\"note\":\"samodzielny druk niepotwierdzony. Uwagi źródłowe: Utwór potwierdzony jako element zbioru. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"uncertain\":true,\"contents\":[],\"omnibusTitles\":[\"Grombrindal: Ancestor’s Burden\"]},{\"id\":\"f0510\",\"number\":null,\"title\":\"High Airs\",\"pl\":null,\"series\":\"AoS · Grombrindal\",\"author\":\"Chris Thursten\",\"year\":null,\"universe\":\"Age of Sigmar\",\"kind\":\"opowiadanie\",\"sourceStatus\":\"samodzielny druk niepotwierdzony\",\"workId\":\"U0356\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"raw\":\"U0356 · High Airs · opowiadanie · samodzielny druk niepotwierdzony\",\"note\":\"samodzielny druk niepotwierdzony. Uwagi źródłowe: Utwór potwierdzony jako element zbioru. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"uncertain\":true,\"contents\":[],\"omnibusTitles\":[\"Grombrindal: Ancestor’s Burden\"]},{\"id\":\"f0511\",\"number\":null,\"title\":\"Durkar's Wake\",\"pl\":null,\"series\":\"AoS · Grombrindal\",\"author\":\"Chris Thursten\",\"year\":null,\"universe\":\"Age of Sigmar\",\"kind\":\"opowiadanie\",\"sourceStatus\":\"samodzielny druk niepotwierdzony\",\"workId\":\"U0357\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"raw\":\"U0357 · Durkar's Wake · opowiadanie · samodzielny druk niepotwierdzony\",\"note\":\"samodzielny druk niepotwierdzony. Uwagi źródłowe: Utwór potwierdzony jako element zbioru. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"uncertain\":true,\"contents\":[],\"omnibusTitles\":[\"Grombrindal: Ancestor’s Burden\"]},{\"id\":\"f0512\",\"number\":null,\"title\":\"King Osgek's Prize\",\"pl\":null,\"series\":\"AoS · Grombrindal\",\"author\":\"Chris Thursten\",\"year\":null,\"universe\":\"Age of Sigmar\",\"kind\":\"opowiadanie\",\"sourceStatus\":\"samodzielny druk niepotwierdzony\",\"workId\":\"U0358\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"raw\":\"U0358 · King Osgek's Prize · opowiadanie · samodzielny druk niepotwierdzony\",\"note\":\"samodzielny druk niepotwierdzony. Uwagi źródłowe: Utwór potwierdzony jako element zbioru. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"uncertain\":true,\"contents\":[],\"omnibusTitles\":[\"Grombrindal: Ancestor’s Burden\"]},{\"id\":\"f0513\",\"number\":null,\"title\":\"No God's Land\",\"pl\":null,\"series\":\"AoS · Grombrindal\",\"author\":\"Chris Thursten\",\"year\":null,\"universe\":\"Age of Sigmar\",\"kind\":\"opowiadanie\",\"sourceStatus\":\"samodzielny druk niepotwierdzony\",\"workId\":\"U0359\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"raw\":\"U0359 · No God's Land · opowiadanie · samodzielny druk niepotwierdzony\",\"note\":\"samodzielny druk niepotwierdzony. Uwagi źródłowe: Utwór potwierdzony jako element zbioru. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"uncertain\":true,\"contents\":[],\"omnibusTitles\":[\"Grombrindal: Ancestor’s Burden\"]},{\"id\":\"f0514\",\"number\":null,\"title\":\"Bitter Oaths\",\"pl\":null,\"series\":\"AoS · Grombrindal\",\"author\":\"Chris Thursten\",\"year\":null,\"universe\":\"Age of Sigmar\",\"kind\":\"opowiadanie\",\"sourceStatus\":\"samodzielny druk niepotwierdzony\",\"workId\":\"U0360\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"raw\":\"U0360 · Bitter Oaths · opowiadanie · samodzielny druk niepotwierdzony\",\"note\":\"samodzielny druk niepotwierdzony. Uwagi źródłowe: Utwór potwierdzony jako element zbioru. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"uncertain\":true,\"contents\":[],\"omnibusTitles\":[\"Grombrindal: Ancestor’s Burden\"]},{\"id\":\"f0515\",\"number\":null,\"title\":\"The Maker's Promise\",\"pl\":null,\"series\":\"AoS · Grombrindal\",\"author\":\"Chris Thursten\",\"year\":null,\"universe\":\"Age of Sigmar\",\"kind\":\"krótka powieść\",\"sourceStatus\":\"samodzielny druk niepotwierdzony\",\"workId\":\"U0361\",\"catalogCurrent\":true,\"contentsCoverageVerified\":false,\"raw\":\"U0361 · The Maker's Promise · krótka powieść · samodzielny druk niepotwierdzony\",\"note\":\"samodzielny druk niepotwierdzony. Uwagi źródłowe: Utwór potwierdzony jako element zbioru. Katalog z 17.10.2026; wpis bibliograficzny nie oznacza posiadania.\",\"uncertain\":true,\"contents\":[],\"omnibusTitles\":[\"Grombrindal: Ancestor’s Burden\"]}]");
//#endregion
//#region lib/bibliography-import.json
var bibliography_import_default = /* @__PURE__ */ JSON.parse("[{\"names\":[\"Trollslayer\",\"Zabójca Trolli\"],\"authors\":[\"William King\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Skavenslayer\",\"Zabójca Skavenów\"],\"authors\":[\"William King\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Daemonslayer\",\"Zabójca Demonów\"],\"authors\":[\"William King\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Dragonslayer\",\"Zabójca Smoków\"],\"authors\":[\"William King\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Beastslayer\",\"Zabójca Bestii\"],\"authors\":[\"William King\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Vampireslayer\",\"Zabójca Wampirów\"],\"authors\":[\"William King\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Giantslayer\",\"Zabójca Gigantów\"],\"authors\":[\"William King\"],\"editions\":[{\"isbn\":\"9788386758463\",\"language\":\"PL\",\"format\":\"papier · miękka\",\"source\":\"https://copcorp.pl/produkt/zabojca-gigantow/\"}],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Orcslayer\",\"Zabójca Orków\"],\"authors\":[\"Nathan Long\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Manslayer\",\"Zabójca Ludzi\"],\"authors\":[\"Nathan Long\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Elfslayer\",\"Zabójca Elfów\"],\"authors\":[\"Nathan Long\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Shamanslayer\",\"Zabójca Szamanów\"],\"authors\":[\"Nathan Long\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Zombieslayer\",\"Zabójca Zombi\"],\"authors\":[\"Nathan Long\"],\"editions\":[{\"isbn\":\"9788361656432\",\"language\":\"PL\",\"format\":\"papier · miękka\",\"source\":\"https://copcorp.pl/produkt/zabojca-zombi/\"}],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gotrek and Felix: The First Omnibus\",\"Przygody Gotreka i Felixa — Omnibus I\"],\"authors\":[\"autorzy/redakcja do weryfikacji [źródło BL]\"],\"editions\":[{\"isbn\":\"9788382320909\",\"language\":\"PL\",\"format\":\"papier · twarda\",\"source\":\"https://copcorp.pl/produkt/omnibus-i-przygody-gotreka-i-felixa/\"}],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gotrek and Felix: The Second Omnibus\",\"Przygody Gotreka i Felixa — Omnibus II\"],\"authors\":[\"autorzy/redakcja do weryfikacji [źródło BL]\"],\"editions\":[{\"isbn\":\"\",\"language\":\"PL\",\"format\":\"papier · twarda\",\"source\":\"https://copcorp.pl/produkt/omnibus-ii-przygody-gotreka-i-felixa/\"}],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gotrek and Felix: The Third Omnibus\",\"Przygody Gotreka i Felixa — Omnibus III\"],\"authors\":[\"autorzy/redakcja do weryfikacji [źródło BL]\"],\"editions\":[{\"isbn\":\"9788382322613\",\"language\":\"PL\",\"format\":\"papier · twarda\",\"source\":\"https://copcorp.pl/produkt/omnibus-iii-przygody-gotreka-i-felixa/\"}],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Bloodborn\",\"Zrodzona we krwi\"],\"authors\":[\"Nathan Long\"],\"editions\":[{\"isbn\":\"9788382320763\",\"language\":\"PL\",\"format\":\"papier · miękka\",\"source\":\"https://copcorp.pl/produkt/zrodzona-we-krwi/\"}],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Bloodforged\",\"Zahartowana we krwi\"],\"authors\":[\"Nathan Long\"],\"editions\":[{\"isbn\":\"9788382320947\",\"language\":\"PL\",\"format\":\"papier · miękka\",\"source\":\"https://copcorp.pl/produkt/zahartowana-we-krwi/\"}],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Vampire Wars\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Grey Seer\",\"Szary Prorok\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Temple of the Serpent\",\"Świątynia Węża\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Thanquol’s Doom\",\"Zagłada Thanquola\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Mathias Thulmann: Witch Hunter\",\"Mathias Thulmann: Łowca czarownic — Omnibus\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Palace of the Plague Lord\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Blood for the Blood God\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Road of Skulls\"],\"authors\":[\"Josh Reynolds\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"City of the Damned\",\"Miasto potępionych\"],\"authors\":[\"David Guymer\"],\"editions\":[{\"isbn\":\"9788361656920\",\"language\":\"PL\",\"format\":\"papier · miękka\",\"source\":\"https://copcorp.pl/produkt/miasto-potepionych/\"}],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Serpent Queen\"],\"authors\":[\"Josh Reynolds\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Kinslayer\"],\"authors\":[\"David Guymer\"],\"editions\":[{\"isbn\":\"9788382320084\",\"language\":\"PL\",\"format\":\"papier · miękka\",\"source\":\"https://copcorp.pl/produkt/zabojca-krasnoludow/\"}],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Slayer\"],\"authors\":[\"David Guymer\"],\"editions\":[{\"isbn\":\"9788382320145\",\"language\":\"PL\",\"format\":\"papier · miękka\",\"source\":\"https://copcorp.pl/produkt/zabojca/\"}],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gotrek and Felix: The Anthology\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gotrek and Felix: Lost Tales\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gotrek and Felix: Myths and Legends\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gotrek and Felix: Fourth Omnibus\"],\"authors\":[\"autorzy/redakcja do weryfikacji [źródło BL]\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gotrek and Felix: The Fifth Omnibus\"],\"authors\":[\"autorzy/redakcja do weryfikacji [źródło BL]\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gotrek & Felix: The Sixth Omnibus\"],\"authors\":[\"David Guymer [źródło BL]\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Daemon’s Curse\",\"Klątwa Demona\"],\"authors\":[\"Dan Abnett / Mike Lee\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Bloodstorm\",\"Krwawy Sztorm\"],\"authors\":[\"Dan Abnett / Mike Lee\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Reaper of Souls\",\"Żniwiarz Dusz\"],\"authors\":[\"Dan Abnett / Mike Lee\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Warpsword\",\"Spaczony Miecz\"],\"authors\":[\"Dan Abnett / Mike Lee\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Lord of Ruin\",\"Władca Zniszczenia\"],\"authors\":[\"Dan Abnett / Mike Lee\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Deathblade\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Chronicles of Malus Darkblade: Volume One\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Chronicles of Malus Darkblade: Volume Two\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Bloodsworn\",\"Zaprzysiężona we krwi\"],\"authors\":[\"Nathan Long\"],\"editions\":[{\"isbn\":\"9788382321074\",\"language\":\"PL\",\"format\":\"papier · miękka\",\"source\":\"https://copcorp.pl/produkt/zaprzysiezona-we-krwi/\"}],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Ulrika the Vampire: The Omnibus\",\"Wampirzyca Ulrika — Omnibus\"],\"authors\":[\"Nathan Long\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Drachenfels\"],\"authors\":[\"Jack Yeovil / Kim Newman\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Genevieve Undead\"],\"authors\":[\"Jack Yeovil (Kim Newman)\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Beasts in Velvet\"],\"authors\":[\"Jack Yeovil / Kim Newman\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Silver Nails\"],\"authors\":[\"Jack Yeovil (Kim Newman)\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Inheritance\"],\"authors\":[\"Steven Savile\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Dominion\"],\"authors\":[\"Steven Savile\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Retribution\"],\"authors\":[\"Steven Savile\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Death’s Cold Kiss\"],\"authors\":[\"Steven Savile\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Court of the Crimson Queen\"],\"authors\":[\"Steven Savile\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Witch Hunter\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Witch Finder\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Witch Killer\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Blood Money\",\"Krwawa forsa\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Blood and Steel\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Blood of the Dragon\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Burning Shore\"],\"authors\":[\"Robert Earl\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Wild Kingdoms\"],\"authors\":[\"Robert Earl\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Savage City\"],\"authors\":[\"Robert Earl\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Ambassador\"],\"authors\":[\"Graham McNeill\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Ursun’s Teeth\"],\"authors\":[\"Graham McNeill\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Honour of the Grave\"],\"authors\":[\"Robin D. Laws\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Sacred Flesh\"],\"authors\":[\"Robin D. Laws\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Liar’s Peak\"],\"authors\":[\"Robin D. Laws\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Dead and the Damned\"],\"authors\":[\"Jonathan Green\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Valnir’s Bane\"],\"authors\":[\"Nathan Long\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Broken Lance\"],\"authors\":[\"Nathan Long\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Tainted Blood\"],\"authors\":[\"Nathan Long\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Blackhearts: The Omnibus\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Blood Bowl\"],\"authors\":[\"Matt Forbeck\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Dead Ball\"],\"authors\":[\"Matt Forbeck\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Death Match\"],\"authors\":[\"Matt Forbeck\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Rumble in the Jungle\"],\"authors\":[\"Matt Forbeck\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Death’s Messenger\"],\"authors\":[\"Sandy Mitchell\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Death’s City\"],\"authors\":[\"Sandy Mitchell\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Death’s Legacy\"],\"authors\":[\"Sandy Mitchell\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Wulfrik\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Warriors of the Chaos Wastes\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Day of the Daemon\"],\"authors\":[\"Aaron Rosenberg\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Night of the Daemon\"],\"authors\":[\"Aaron Rosenberg\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Hour of the Daemon\"],\"authors\":[\"Aaron Rosenberg\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Grudge Bearer\"],\"authors\":[\"Gav Thorpe\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Oathbreaker\"],\"authors\":[\"Nick Kyme\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Honourkeeper\"],\"authors\":[\"Nick Kyme\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Masters of Steel and Stone\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Warlords of Karak Eight Peaks\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Guardians of the Forest\"],\"authors\":[\"Graham McNeill\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Defenders of Ulthuan\"],\"authors\":[\"Graham McNeill\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Sons of Ellyrion\"],\"authors\":[\"Graham McNeill\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Elves: The Omnibus\"],\"authors\":[\"autorzy/redakcja do weryfikacji [źródło BL]\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Reiksguard\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Iron Company\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Call to Arms\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Grimblades\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Warrior Priest\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Empire\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Empire at War\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gilead’s Blood\"],\"authors\":[\"Dan Abnett / Nik Vincent\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gilead’s Curse\"],\"authors\":[\"Dan Abnett / Nik Vincent\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Knight Errant\"],\"authors\":[\"Anthony Reynolds\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Knight of the Realm\"],\"authors\":[\"Anthony Reynolds\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Questing Knight\"],\"authors\":[\"Anthony Reynolds\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Grail Knight\"],\"authors\":[\"Anthony Reynolds\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Knights of Bretonnia\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Konrad\"],\"authors\":[\"David Ferring\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Shadowbreed\"],\"authors\":[\"David Ferring\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Warblade\"],\"authors\":[\"David Ferring\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"A Murder in Marienburg\"],\"authors\":[\"David Bishop\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"A Massacre in Marienburg\"],\"authors\":[\"David Bishop\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Mark of Damnation\"],\"authors\":[\"James Wallis\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Mark of Heresy\"],\"authors\":[\"James Wallis\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Orion: The Vaults of Winter\"],\"authors\":[\"Darius Hinks\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Orion: Tears of Isha\"],\"authors\":[\"Darius Hinks\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Orion: The Council of Beasts\"],\"authors\":[\"Darius Hinks\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Warhammer Chronicles: The Orion Trilogy\"],\"authors\":[\"autorzy według spisu zawartości Black\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Claws of Chaos\"],\"authors\":[\"Gav Thorpe\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Blades of Chaos\"],\"authors\":[\"Gav Thorpe\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Heart of Chaos\"],\"authors\":[\"Gav Thorpe\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Star of Erengrad\"],\"authors\":[\"Neil McIntosh\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Taint of Evil\"],\"authors\":[\"Neil McIntosh\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Keepers of the Flame\"],\"authors\":[\"Neil McIntosh\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Razumov’s Tomb\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Hour of Shadows\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Dragonmage\"],\"authors\":[\"Chris Wraight\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Zaragoz\"],\"authors\":[\"Brian Craig\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Plague Daemon\"],\"authors\":[\"Brian Craig\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Storm Warriors\"],\"authors\":[\"Brian Craig\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Hammers of Ulric\"],\"authors\":[\"Dan Abnett i inni\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Riders of the Dead\"],\"authors\":[\"Dan Abnett i inni\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Heldenhammer\"],\"authors\":[\"Graham McNeill\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Empire\"],\"authors\":[\"Graham McNeill\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"God King\"],\"authors\":[\"Graham McNeill\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Legend of Sigmar\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Nagash the Sorcerer\"],\"authors\":[\"Mike Lee\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Nagash the Unbroken\"],\"authors\":[\"Mike Lee\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Nagash Immortal\"],\"authors\":[\"Mike Lee\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Rise of Nagash\"],\"authors\":[\"Mike Lee\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Malekith\"],\"authors\":[\"Gav Thorpe\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Shadow King\"],\"authors\":[\"Gav Thorpe\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Caledor\"],\"authors\":[\"Gav Thorpe\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Aenarion\"],\"authors\":[\"Gav Thorpe\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Bloody Handed\"],\"authors\":[\"Gav Thorpe\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Sundering\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Dead Winter\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Blighted Empire\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Wolf of Sigmar\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Skaven Wars: The Black Plague Trilogy\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Great Betrayal\"],\"authors\":[\"Nick Kyme\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Master of Dragons\"],\"authors\":[\"Chris Wraight\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Curse of the Phoenix Crown\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The War of Vengeance\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Neferata\"],\"authors\":[\"Josh Reynolds\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Master of Death\"],\"authors\":[\"Josh Reynolds\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Blood of Aenarion\"],\"authors\":[\"William King\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Sword of Caledor\"],\"authors\":[\"William King\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Bane of Malekith\"],\"authors\":[\"William King\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Tyrion and Teclis Omnibus\"],\"authors\":[\"autorzy według spisu zawartości Black Library [źródło\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Ancient Blood\"],\"authors\":[\"Robert Earl\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Curse of the Necrarch\"],\"authors\":[\"Steven Savile\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Red Duke\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Undeath Ascendant\"],\"authors\":[\"autorzy/redakcja do weryfikacji [źródło BL]\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Luthor Huss\"],\"authors\":[\"Chris Wraight\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Sword of Justice\"],\"authors\":[\"Chris Wraight\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Sword of Vengeance\"],\"authors\":[\"Chris Wraight\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Headtaker\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Skarsnik\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Valkia the Bloody\"],\"authors\":[\"Sarah Cawkwell\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Sigvald\"],\"authors\":[\"Darius Hinks\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Van Horstmann\"],\"authors\":[\"Ben Counter\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Swords of the Emperor\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Heroes of the Empire\"],\"authors\":[\"autorzy według spisu zawartości Black Library [źródło BL]\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Champions of Chaos\"],\"authors\":[\"autorzy według spisu zawartości Black Library [źródło BL]\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Archaon: Everchosen\",\"Archaon: Wszechwybraniec\"],\"authors\":[\"Rob Sanders\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Archaon: Lord of Chaos\",\"Archaon: Władca Chaosu\"],\"authors\":[\"Rob Sanders\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Return of Nagash\",\"Powrót Nagasha\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Fall of Altdorf\",\"Upadek Altdorfu\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Curse of Khaine\",\"Klątwa Khaina\"],\"authors\":[\"Gav Thorpe\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Rise of the Horned Rat\",\"Świt Rogatego Szczura\"],\"authors\":[\"Guy Haley\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Lord of the End Times\",\"Pan Końca Czasów\"],\"authors\":[\"Josh Reynolds\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The End Times: Doom of the Old World\"],\"authors\":[\"autorzy według spisu zawartości Black Library\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Empire in Chaos\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Dark Storm Gathering\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Forged by Chaos\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Lords of the Lance\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Blood of the Bastion\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Zavant\"],\"authors\":[\"Gordon Rennie / Josh Reynolds\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Wolf Riders\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Ignorant Armies\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Red Thirst\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Realm of Chaos\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Lords of Valour\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Laughter of Dark Gods\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Way of the Dead\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Swords of the Empire\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Cold Hand of Betrayal\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Tales of the Old World\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Invasion!\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Death and Dishonour\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"War Unending\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Age of Legend\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Best of Hammer and Bolter: Volume One\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Best of Hammer and Bolter: Volume Two\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Lord of Undeath\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Gates of Azyr\"],\"authors\":[\"Chris Wraight\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"War Storm\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Ghal Maraz\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Hammers of Sigmar\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Call of Archaon\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Wardens of the Everqueen\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Warbeast\"],\"authors\":[\"Gav Thorpe\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Fury of Gork\"],\"authors\":[\"Josh Reynolds\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Bladestorm\"],\"authors\":[\"Matt Westbrook\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Mortarch of Night\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Realmgate Wars: Volume 1\"],\"authors\":[\"różni autorzy\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Realmgate Wars: Volume 2\"],\"authors\":[\"różni autorzy\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Fyreslayers\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Skaven Pestilens\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Sylvaneth\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Black Rift\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Legends of the Age of Sigmar: Omnibus 1\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Plague Garden\",\"Ogród Plagi — Błogosławieni Rycerze\"],\"authors\":[\"Josh Reynolds\"],\"editions\":[{\"isbn\":\"9788382320787\",\"language\":\"PL\",\"format\":\"papier · zintegrowana\",\"source\":\"https://copcorp.pl/produkt/ogrod-plagi/\"}],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Black Pyramid\",\"Czarna Piramida — Błogosławieni Rycerze\"],\"authors\":[\"Josh Reynolds\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"City of Secrets\"],\"authors\":[\"Nick Horth i inni\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Silver Shard\",\"Callis i Toll: Srebrny Odłamek\"],\"authors\":[\"Nick Horth i inni\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Callis & Toll\"],\"authors\":[\"Nick Horth i inni\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Spear of Shadows\"],\"authors\":[\"Josh Reynolds\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Dominion of Bones\"],\"authors\":[\"David Annandale\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Ghoulslayer\",\"Zabójca Ghuli\"],\"authors\":[\"Darius Hinks\"],\"editions\":[{\"isbn\":\"9788382320466\",\"language\":\"PL\",\"format\":\"papier · miękka\",\"source\":\"https://copcorp.pl/produkt/zabojca-ghuli/\"}],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gitslayer\",\"Zabójca Pentaków\"],\"authors\":[\"Darius Hinks\"],\"editions\":[{\"isbn\":\"9788382320770\",\"language\":\"PL\",\"format\":\"papier · miękka\",\"source\":\"https://copcorp.pl/produkt/zabojca-pentakow/\"}],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Soulslayer\",\"Zabójca Dusz\"],\"authors\":[\"Darius Hinks\"],\"editions\":[{\"isbn\":\"9788382322538\",\"language\":\"PL\",\"format\":\"papier · miękka\",\"source\":\"https://copcorp.pl/produkt/zabojca-dusz/\"}],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Blightslayer\",\"Zabójca Zarazy\"],\"authors\":[\"Richard Strachan\"],\"editions\":[{\"isbn\":\"9788382322958\",\"language\":\"PL\",\"format\":\"papier · miękka\",\"source\":\"https://copcorp.pl/produkt/zabojca-zarazy/\"}],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Verminslayer\",\"Zabójca Szkodników\"],\"authors\":[\"Darius Hinks / Richard Strachan i inni\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Realmslayer: Legend of the Doomseeker\"],\"authors\":[\"David Guymer i inni\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gotrek and Maleneth: The Omnibus\"],\"authors\":[\"David Guymer i inni\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Bone Desert\"],\"authors\":[\"Robbie MacNiven\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Soul Wars\",\"Wojny Dusz\"],\"authors\":[\"Josh Reynolds\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gloomspite\",\"W blasku Złego Księżyca\"],\"authors\":[\"Andy Clark\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Cursed City\",\"Przeklęte Miasto\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Godeater’s Son\",\"Syn Bogożercy\"],\"authors\":[\"Noah Van Nguyen\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Overlords of the Iron Dragon\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Court of the Blind King\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Arkanaut’s Oath\"],\"authors\":[\"Guy Haley\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Ghosts of Barak-Minoz\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Profit’s Ruin\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Children of Teclis\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Last Volari\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Grombrindal: Chronicles of the Wanderer\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gothghul Hollow\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Hollow King\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Vulture Lord\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Prince Maesa\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Godsbane\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Hallowed Ground\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Kragnos: Avatar of Destruction\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"A Dynasty of Monsters\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The End of Enlightenment\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Stormvault\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Covens of Blood\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Realm-Lords\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Lady of Sorrows\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Beastgrave\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Shadespire: The Mirrored City\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Skaventide\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Darkoath\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Dead Kingdom\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Blacktalon\"],\"authors\":[\"Liane Merciel\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Temple of Silence\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Yndrasta: The Celestial Spear\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Lioness of the Parch\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Shade of Khaine\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Queen of the Rose Throne\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Ushoran: Mortarch of Delusion\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Starseer’s Ruin\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Abraxia: Spear of the Everchosen\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"First Marshal\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Soulblight Gravelords: Masters of Death\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Anvils of the Heldenhammer: The Ancients\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Hammers of Sigmar: First Forged\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Bad Loon Rising\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Untamed Realms\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Red Feast\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Harrowdeep\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Undying King\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Blacktalon: First Mark\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Tainted Heart\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Dark Harvest\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Measure of Iron\"],\"authors\":[\"Jamie Crisalli\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Last Knight\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Castle of Blood\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Warqueen\"],\"authors\":[\"autor do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Heart of Winter\"],\"authors\":[\"Nick Horth\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Red Hours\"],\"authors\":[\"Evan Dicken\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gods and Mortals\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Hammerhal & Other Stories\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Sacrosanct & Other Stories\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Hammer and the Eagle\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Conquest Unbound: Stories from the Mortal Realms\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"On the Shoulders of Giants and Other Stories\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Thunderstrike & Other Stories\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Warriors of the Freeguilds\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"War for the Mortal Realms\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Inferno! An Age of Sigmar Collection\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Champions of the Mortal Realms\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Realm of Beasts\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Realm of Death\"],\"authors\":[\"autorzy/redakcja do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Myths & Revenants\"],\"authors\":[\"różni autorzy\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Grombrindal: Ancestor’s Burden\"],\"authors\":[\"Chris Thursten\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Death and Glory\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"A Place of Quiet Assembly\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Blood Sport\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Kineater\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Mind-Stealer\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Tilean’s Talisman\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Two Crowns of Ras Karim\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Prophecy\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"A Cask of Wynters\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Redhand’s Daughter\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Oberwald Ripper\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Red Snow\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Last Orders\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Slayer of the Storm God\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Slayer’s Honour\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Funeral of Gotrek Gurnisson\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Rememberers\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Blood Price\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Bloodwalker\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Charnel Congress\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Marriage of Moment\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Berthold’s Beard\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Reckoning\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Contest\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Into the Valley of Death\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Curse of the Everliving\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Rest Eternal\"],\"authors\":[\"Anthony Reynolds\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Doom of Dragonback\"],\"authors\":[\"Gav Thorpe\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Rotten Fruit\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Hetzau’s Follies\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Thorgrim\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Karag Durak Grudge\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The King of Black Crag\"],\"authors\":[\"do weryfikacji\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Kinstrife\"],\"authors\":[\"Graham McNeill\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Deathmasque\"],\"authors\":[\"Graham McNeill\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Freedom’s Home or Glory’s Grave\"],\"authors\":[\"Graham McNeill\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Plague Priest\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Plague Doktor\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"A Question of Faith\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Last Man\"],\"authors\":[\"C. L. Werner\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Let the Great Axe Fall\"],\"authors\":[\"Graham McNeill\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Gods of Flesh and Blood\"],\"authors\":[\"Graham McNeill\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Sword Guardian\"],\"authors\":[\"Graham McNeill\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Rat-Tail\"],\"authors\":[\"Chris Thursten\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"High Airs\"],\"authors\":[\"Chris Thursten\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Durkar's Wake\"],\"authors\":[\"Chris Thursten\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"King Osgek's Prize\"],\"authors\":[\"Chris Thursten\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"No God's Land\"],\"authors\":[\"Chris Thursten\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Bitter Oaths\"],\"authors\":[\"Chris Thursten\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"The Maker's Promise\"],\"authors\":[\"Chris Thursten\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"},{\"names\":[\"Picking the Bones\"],\"authors\":[\"Mike Lee\"],\"editions\":[],\"source\":\"/catalog-fantasy-2026-10-17.xlsx\"}]");
//#endregion
//#region lib/book-matching.ts
var normalizeBookText = (s) => s.replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, decimal) => String.fromCodePoint(Math.min(parseInt(hex || decimal, hex ? 16 : 10), 1114111))).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").replace(/[^a-z0-9]+/g, " ").trim();
var unrelated = /\b(mtg|cd|dvd|vinyl|lp|ep|lego|stl)\b|blu[ -]?ray|magic:? the gathering|pok[eé]mon|yu-?gi-?oh|karta kolekcjonerska|rodzaj:? single|figurki?|miniatures?|joytoy|ebook|e-book|audiobook|kindle|gra planszowa|gra karciana|board game|płyta|płyty|plyta|plyty|winyl|soundtrack|album muzyczny|music album|bookmark|poster|artwork|dust jacket only|book cover only|resin|unpainted|painted|action figure|dreadknight|combat patrol|battleforce|sprue|on sprue|assembled|citadel miniature|plastic kit|model kit/i;
var specificAuthors = (values) => [...new Set(values.flatMap((value) => value.split(/\s*[\/;]\s*/)).map((value) => value.replace(/\s+i inni.*$/i, "").trim()).filter((value) => value && !/r[oó][zż]ni|various|redaktorzy|autorzy|weryfikacji|nieustalon/i.test(value)))];
var knownAuthors = [
	...specificAuthors(books_default.flatMap((book) => book.author ? [book.author] : [])),
	"Dan Abnett",
	"Graham McNeill",
	"James Swallow",
	"Aaron Dembski-Bowden",
	"Mike Lee",
	"Mitchel Scanlon",
	"Nick Kyme",
	"Guy Haley",
	"Chris Wraight",
	"John French",
	"Gav Thorpe",
	"William King",
	"Sandy Mitchell",
	"Steve Lyons",
	"Ben Counter",
	"Josh Reynolds",
	"Robbie MacNiven",
	"Andy Clark",
	"Anthony Reynolds",
	"David Annandale",
	"Rachel Harrison",
	"Peter Fehervari",
	"Matthew Farrer",
	"James Wallis",
	"Steve Parker",
	"Mike Brooks",
	"Nate Crowley",
	"Lucien Soulban",
	"Ian Watson",
	"Gordon Rennie",
	"C L Werner",
	"Ian St. Martin"
];
var bibliography = bibliography_import_default;
var metadataIndex = /* @__PURE__ */ new Map();
for (const [index, book] of bibliography.entries()) for (const name of book.names) {
	const key = normalizeBookText(name);
	if (!metadataIndex.has(key)) metadataIndex.set(key, index);
}
function bookMetadata(names) {
	let first = Infinity;
	for (const name of names) {
		const index = metadataIndex.get(normalizeBookText(name));
		if (index !== void 0 && index < first) first = index;
	}
	return Number.isFinite(first) ? bibliography[first] : void 0;
}
function bookAuthors(book) {
	const direct = specificAuthors(book.author ? [book.author] : []), metadata = specificAuthors(bookMetadata([book.title, book.pl || ""])?.authors || []);
	return direct.length ? direct : metadata.length ? metadata : knownAuthors.filter((a) => normalizeBookText((book.raw || "") + " " + (book.series || "")).includes(normalizeBookText(a)));
}
var warhammerContext = /\b(warhammer|40k|40 000|40000|black library|herezja|horus heresy|siege of terra|fantasy|age of sigmar|old world|gotrek|felix)\b/;
var nonFictionProduct = /\b(codex|codices|battletome|rulebook|rule book|core rules|core book|army book|campaign book|campaign supplement|journal tactica|legions imperialis|liber hereticus|liber astartes|warcry|warscroll|enchantment cards|transfer sheet|rpg|podrecznik|podreczniki|komiks|komiksy|comics?|manga|datasheets?|datacards?|miniatury|figurka|figurki|figurek|figurine|figurines|kaseta|kasety|cassette|vinyl|lipstick|pomadka|mascara|gold coins?|medal|moneta|monety|asg|gbbr|magazynki|zdalnie sterowany|zdalnego sterowania)\b/;
var genericTitles = new Set([
	"omnibus",
	"the omnibus",
	"antologia",
	"anthology",
	"powiesc",
	"novel",
	"book",
	"books",
	"ksiazka",
	"ksiazki",
	"trilogy",
	"trylogia",
	"wydanie zbiorcze"
]);
var identityBookNames = (names) => [...new Set(names.filter((n) => n && !genericTitles.has(normalizeBookText(n))).flatMap((n) => [
	normalizeBookText(n),
	normalizeBookText(n.replace(/ \([^)]*\)$/, "")),
	normalizeBookText(n).replace(/\bthe omnibus\b/, "omnibus")
]))];
var authorNames = knownAuthors.flatMap((a) => {
	const n = normalizeBookText(a);
	return [n, n.split(" ").reverse().join(" ")];
});
var listingIdentity = (s) => {
	let n = " " + normalizeBookText(s) + " ";
	for (const author of authorNames) n = n.replace(" " + author + " ", " ");
	return n.replace(/\b(paperback|hardback|hardcover|softcover|pb|hb|eng|english|pl|en|ksiazka|book|novel|nowy produkt|nowa|new|used|by|warhammer 40k|warhammer 40 000|warhammer 40000|warhammer fantasy|warhammer age of sigmar|age of sigmar|the old world|warhammer|the horus heresy|horus heresy|siege of terra|fantasy|age of sigmar|old world|gotrek|felix)\b/g, " ").replace(/\s+/g, " ").trim();
};
var authorTokens = (s) => normalizeBookText(s).split(" ").sort().join(" ");
var authorMatches = (value, author) => {
	const n = normalizeBookText(author), reverse = n.split(" ").reverse().join(" "), text = " " + normalizeBookText(value) + " ";
	return text.includes(" " + n + " ") || text.includes(" " + reverse + " ") || authorTokens(value) === authorTokens(author);
};
var longerBookTitles = {
	"fulgrim": ["fulgrim the palatine phoenix", "fulgrim feniks palatynski"],
	"legion": [
		"legion of the damned",
		"black legion",
		"the emperor s legion",
		"ghost legion",
		"thirteenth legion"
	],
	"scars": ["savage scars"],
	"corax": ["corax lord of shadows", "corax wladca cieni"],
	"garro": ["garro knight of grey"],
	"warhawk": ["jaghatai khan warhawk of chogoris"],
	"xenos": ["xenos hunters"],
	"ravenor": [
		"ravenor returned",
		"ravenor rogue",
		"ravenor the omnibus"
	],
	"mroczne imperium": ["mroczne imperium wojna z zaraza", "mroczne imperium boska sniec"],
	"damocles": [
		"blades of damocles",
		"storm of damocles",
		"star of damocles"
	],
	"armageddon": [
		"the pyres of armageddon",
		"crusade for armageddon",
		"conquest of armageddon",
		"armageddon season of fire",
		"armageddon saint"
	],
	"damnos": ["the fall of damnos"],
	"space wolf": [
		"the space wolf omnibus",
		"the space wolf omnibus tom 1",
		"the space wolf omnibus tom 2"
	],
	"nocturne": ["lords of nocturne"],
	"exile": ["void exile"],
	"eternal": ["sigismund the eternal crusader", "darkness eternal"],
	"apostle": ["zardu layak the crimson apostle", "dark apostle"],
	"grey knights": ["grey knights the omnibus"],
	"deathwatch": ["deathwatch ignition"],
	"legacy": ["legacy of the wulfen", "legacy of caliban"],
	"farsight": [
		"farsight crisis of faith",
		"farsight empire of lies",
		"farsight blade of truth"
	],
	"ruin": ["era of ruin"],
	"ascension": ["day of ascension"],
	"salvation": ["salvation s reach"],
	"relentless": ["the relentless dead"],
	"the lost": [
		"the lost and the damned",
		"lemartes guardian of the lost",
		"wrath of the lost"
	]
};
var currentNames = [...new Set([...bibliography.flatMap((book) => book.names), ...books_default.flatMap((book) => [book.title, book.pl || ""])].filter(Boolean).map(normalizeBookText))];
for (const name of currentNames) {
	const longer = currentNames.filter((other) => other.startsWith(name + " "));
	if (longer.length) longerBookTitles[name] = [...new Set([...longerBookTitles[name] || [], ...longer])];
}
function classifyPaperBook(title, names, evidence = {}) {
	if (unrelated.test(title)) return {
		state: "rejected",
		reason: "Płyta, gra, figurka lub wydanie cyfrowe."
	};
	const text = " " + normalizeBookText(title) + " ", identities = identityBookNames(names);
	if (!identities.some((n) => text.includes(" " + n + " ") || n.startsWith("the ") && listingIdentity(title) === n.slice(4))) return {
		state: "rejected",
		reason: "Tytuł nie pasuje do książki."
	};
	if (identities.some((name) => (longerBookTitles[name] || []).some((longer) => !identities.includes(longer) && text.includes(" " + longer + " ")))) return {
		state: "rejected",
		reason: "Pełny tytuł wskazuje inną książkę z katalogu."
	};
	const meta = bookMetadata(names), expected = specificAuthors(evidence.authors?.length ? evidence.authors : meta?.authors || []);
	const authorText = " " + normalizeBookText(title + " " + (evidence.author || "")) + " ";
	if (nonFictionProduct.test(text)) return {
		state: "rejected",
		reason: "Podręcznik do gry, komiks albo figurka zamiast książki z katalogu."
	};
	if (meta?.names.includes("Legion") && /\b(brandon sanderson|sanderson|julie kagawa|elzbieta cherezinska|e cherezinska|cherezinsk(?:a|iej)|herezinska|simon scarrow|sven hassel|sven hazel|richard schwartz|r schwartz|anthony ryan|ben kane|rosemary sutcliff|r sutcliff|roger zelazny|rudyard kipling|stanislaw wyspianski|harry turtledove|chris bunch|adam przechrzta|raymond e feist|jack williamson|william w johnstone|snorri kristjansson|blaine l pardoe|victor ferreira|magdalena idzik|eligiusz kozlowski|dando collins|legion niesmiertelnych|foreign legion|legion condor|legion superbohaterow|legion of super heroes|legion of superheroes|legion samobojcow|sherlock frankenstein|wunderwaffen|aeon legion|legion plomieni(?:a)?|legion of flame|legion of fire|zapomniany legion|zaginiony legion|dziewiaty legion|ninth legion|lost legion|forgotten legion|wilczy legion|ostatni legion|legion nerona|legion xx valeria|legio ix hispana|legion of space|legion of shadow|legion grozy|legion secret origin|legion way|legion x|legion of x|legion of regrettable|legion klamstwa patrzacego|legion wiele zywotow|stephena leedsa|marvel|superman|star wars|legion etrangere|la legion romana|romance militaire|transparent comparison|legion magazine|jam jest legion|imie moje legion|legion kroniki|ruf der legion|voyage a la legion)\b/.test(authorText)) return {
		state: "rejected",
		reason: "Inna książka lub seria niż Legion Dana Abnetta (Herezja Horusa)."
	};
	if ([
		[["Legion"], /\b(legion of the damned|black legion|shattered legions|the emperors legion|ghost legion|thirteenth legion)\b/],
		[["Fallen Angels", "Upadłe Anioły"], /\bcity of fallen angels\b/],
		[["Nemesis", "Nemezis"], /\b(driver nemesis|nemesis now greenman|hitler|ian kershaw|nemesis games|nemesis spiele|diabolika|nemesis edycja polska rebel|roth p nemesis)\b/],
		[["Betrayer", "Zdrajca"], /\b(zdrajca tronu|zdrajca w naszym typie|john le carre|alwyn hamilton|jack higgins|maria nurowska|maria nurkowska|moj przyjaciel zdrajca|bohater czy zdrajca|zdrajca czy bohater|joanna opiat bojarska|joanna truchel|justyna andrulewicz|krolewski zdrajca|zdrajca z pomnika|slawomir koper|stigly rydz|smiglego rydza|stankiewicz)\b/],
		[["Scars", "Szramy"], /\b(king of scars|scars on ice|leigh bardugo|julia popiel|fortunate ?em|forunateem|anne bailey|marzena milek|scars przewrotny los|blizny zapisane|aria m|hidden scars|andi jaxon|jak psychosystem niszczy nasze dzieci)\b/],
		[[
			"The Outcast Dead",
			"Outcast Dead",
			"Potępieńcy"
		], /\bbruce j hawker\b/],
		[["Prospero Burns"], /\bjournal tactica\b/],
		[["The Saint"], /\b(urdesh|black eyed saint|leslie charteris|simon templar|yves saint laurent)\b/],
		[["Scars", "Szramy"], /\bsavage scars\b/],
		[["Tallarn"], /\bdesert raider lieutenant\b/],
		[["War Without End"], /\breturn of yarrick\b/]
	].some(([books, pattern]) => books.some((book) => names.some((name) => normalizeBookText(name) === normalizeBookText(book))) && pattern.test(authorText))) return {
		state: "rejected",
		reason: "Tytuł lub autor jednoznacznie wskazuje inną książkę albo produkt."
	};
	const present = knownAuthors.filter((a) => authorText.includes(" " + normalizeBookText(a) + " "));
	if (expected.length && present.some((a) => !expected.some((e) => normalizeBookText(a) === normalizeBookText(e))) || /\bharold bloom\b/.test(authorText)) return {
		state: "rejected",
		reason: "Inny autor niż szukanej książki."
	};
	if (evidence.author && expected.length && !expected.some((a) => authorMatches(evidence.author, a)) && !expected.some((a) => normalizeBookText(evidence.author).includes(normalizeBookText(a).split(" ").at(-1)))) return {
		state: "rejected",
		reason: "Autor podany przez sklep nie pasuje."
	};
	if (evidence.isbn && meta?.editions.some((e) => e.isbn && e.isbn === evidence.isbn.replace(/[^0-9X]/g, ""))) return {
		state: "matched",
		reason: "Potwierdzony ISBN wydania."
	};
	if (expected.some((a) => authorMatches(title, a) || evidence.author && authorMatches(evidence.author, a))) return {
		state: "matched",
		reason: "Tytuł i właściwy autor."
	};
	const exact = identities.some((n) => listingIdentity(title) === n || n.startsWith("the ") && listingIdentity(title) === n.slice(4));
	if ((!identities.every((n) => n.split(" ").length <= 2) || exact) && (/black library|copernicus/i.test(evidence.publisher || "") || /games workshop/i.test(evidence.publisher || "") && exact || warhammerContext.test(text) && /\b(book|books|novel|paperback|hardback|hardcover|ksiazka|ksiazki|powiesc|powiesci|tom)\b/.test(text))) return {
		state: "matched",
		reason: "Tytuł i kontekst Warhammera."
	};
	const weak = !knownAuthors.some((a) => authorMatches(title, a) || evidence.author && authorMatches(evidence.author, a)) && !(warhammerContext.test(text) && exact) && !(/games workshop/i.test(evidence.publisher || "") && exact);
	return {
		state: "review",
		confidence: weak ? "weak" : "likely",
		reason: weak ? "Słabe dopasowanie: sam tytuł lub jego fragment, bez potwierdzenia autora lub właściwego wydania." : "Tytuł i związek z Warhammerem; autor lub wydanie wymagają potwierdzenia."
	};
}
//#endregion
//#region lib/polish-antiquarians.ts
var attr$1 = (tag, name) => clean(tag.match(new RegExp("(?:^|\\s)" + name + "=[\"']([^\"']*)[\"']", "i"))?.[1] || "");
function polishProductUrl(raw, shop) {
	try {
		const u = new URL(clean(raw), shop.url);
		if (u.origin !== new URL(shop.url).origin || u.protocol !== "https:" || u.username || u.password) return null;
		if (shop.key === "podkarpacki") {
			const id = u.searchParams.get("id")?.match(/^(\d+)(?:\/[^?#]*)?$/)?.[1];
			return u.pathname === "/produkt" && id ? u.origin + "/produkt?id=" + id : null;
		}
		return (["kroliczajama", "hermeszaczytany"].includes(shop.key) ? /^\/\d{3,}-[^/]+$/.test(u.pathname) : ["grochowski", "tomik"].includes(shop.key) ? /^\/pl\/p\/[^/]+\/\d+$/.test(u.pathname) : shop.key === "zakladka" ? /^\/produkt\/[^/]+\/$/.test(u.pathname) : shop.key === "poliart" && /^\/ksiazki-czasopisma-kartografia-i-nuty\/\d+-[^/]+\.html$/.test(u.pathname)) ? u.origin + u.pathname : null;
	} catch {
		return null;
	}
}
function element(html, pattern) {
	const m = pattern.exec(html);
	if (!m) return "";
	const tag = m[0].match(/^<([a-z][\w-]*)\b/i)?.[1];
	if (!tag) return "";
	const tokens = new RegExp("<\\/?" + tag + "\\b[^>]*>", "gi");
	tokens.lastIndex = m.index;
	let depth = 0;
	for (let t; t = tokens.exec(html);) {
		depth += /^<\//.test(t[0]) ? -1 : /\/>$/.test(t[0]) ? 0 : 1;
		if (depth === 0) return html.slice(m.index, tokens.lastIndex);
	}
	return "";
}
var rowFields = (html) => {
	const map = /* @__PURE__ */ new Map();
	for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
		const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => clean(m[1]));
		if (cells.length === 2) map.set(normalizeBookText(cells[0]), cells[1]);
	}
	return map;
};
var stateOf = (state) => /\bużywan|jak now|dobr|bdb|dostatecz|otar|sfaty|pożół|★|^\(?[1-5](?:\D|$)/i.test(state) ? "used" : /^(?:now[ay]|nieużywan[ay])$/i.test(state.trim()) ? "new" : "unknown";
function nodes$1(html) {
	const out = [];
	for (const m of html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) try {
		const data = JSON.parse(m[1]);
		out.push(...Array.isArray(data) ? data : data["@graph"] || [data]);
	} catch {}
	return out;
}
function parsePolishAntiquarianProduct(html, b, checked, shop, pageUrl) {
	const safe = polishProductUrl(pageUrl, shop);
	if (!safe) return [];
	const canonical = [...html.matchAll(/<link\b[^>]*>/gi)].find((m) => attr$1(m[0], "rel") === "canonical");
	if (canonical && polishProductUrl(attr$1(canonical[0], "href"), shop) !== safe) return [];
	const schemas = nodes$1(html);
	const dom = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
	let main = element(dom, /<div\b(?=[^>]*\sitemscope\b)(?=[^>]*\sitemtype=["']https?:\/\/schema.org\/Product["'])[^>]*>/i);
	if (!main) {
		const heading = dom.search(/<h1\b/i);
		if (heading >= 0) main = dom.slice(heading).split(/<section\b[^>]*class=["'][^"']*related|<footer\b|<div\b[^>]*data-module-name=["'](?:related_products|product_related)["']/i)[0];
	}
	if (shop.key === "podkarpacki") main = element(dom, /<div\b[^>]*class=["']panel panel-success["'][^>]*>\s*<div\b[^>]*class=["']panel-heading["'][^>]*>\s*<h3\b[^>]*class=["']panel-title["'][^>]*>(?!Wyszukiwarka|Kategorie|Polecamy|Koszyk|Nasze aukcje)/i);
	if (!main) return [];
	const fields = rowFields(main);
	let title = clean(main.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
	if (shop.key === "podkarpacki") title = fields.get("tytul") || "";
	if (!title) return [];
	let detail = clean(element(main, /<div\b[^>]*itemprop=["']description["'][^>]*>/i) || element(main, /<div\b[^>]*id=["']tab-description["'][^>]*>/i) || ""), price = "", currency = "", availability = "", condition = "unknown", isbn = "", author = fields.get("autor") || "", publisher = fields.get("wydawnictwo") || "", language = fields.get("jezyk") || "", paper = false;
	const prop = (name) => {
		const tag = main.match(new RegExp("<[^>]*\\sitemprop=[\"']" + name + "[\"'][^>]*>([^<]*)", "i"));
		return tag ? attr$1(tag[0], "content") || attr$1(tag[0], "href") || clean(tag[1]) : "";
	};
	if ([
		"kroliczajama",
		"hermeszaczytany",
		"grochowski"
	].includes(shop.key)) {
		price = prop("price");
		currency = prop("priceCurrency");
		availability = prop("availability");
		const label = (name) => detail.match(new RegExp("(?:^|\\s)" + name + "\\s*:\\s*(.*?)(?=\\s+(?:Autor|Wydawnictwo|Okładka|Stan|Uwagi|ISBN)\\s*:|$)", "i"))?.[1] || "";
		author = author || label("Autor");
		publisher = publisher || label("Wydawnictwo");
		const cover = fields.get("oprawa") || label("Okładka");
		condition = stateOf(fields.get("stan ksiazki") || label("Stan"));
		paper = /miękk|tward|broszur|karton/i.test(cover) && (/\d/.test(fields.get("liczba stron") || "") || !!author && !!publisher);
	}
	if (shop.key === "tomik") {
		for (const n of schemas) {
			if (polishProductUrl(n["@id"] || "", shop) !== safe) continue;
			for (const f of n.additionalProperty || []) fields.set(normalizeBookText(f.name || ""), clean(String(f.value || "")));
			if (n.brand?.name) publisher = n.brand.name;
			const o = n.offers;
			if (o && (!o["@id"] || polishProductUrl(o["@id"], shop) === safe)) {
				if (o.price != null) {
					price = String(o.price);
					currency = o.priceCurrency || "";
				}
				if (o.availability) availability = o.availability;
			}
		}
		paper = /miękk|tward|broszur|karton/i.test(fields.get("oprawa") || "") && /^\d+/.test(fields.get("liczba stron") || "");
		condition = stateOf(fields.get("stan") || "");
		language = fields.get("jezyk") || "";
	}
	if (shop.key === "podkarpacki") {
		const current = fields.get("cena") || "";
		price = current.replace(/[^\d,.]/g, "");
		currency = /zł|PLN/.test(current) ? "PLN" : "";
		const count = fields.get("ilosc na magazynie");
		if (count !== void 0 && /^\d+$/.test(count)) availability = Number(count) > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock";
		detail = clean(main);
		condition = stateOf(detail.match(/Stan\s+([^.]*)\./i)?.[1] || "");
		paper = /miękk|tward|broszur|karton/i.test(fields.get("okladka") || "") && /^\d+/.test(fields.get("ilosc stron") || "");
	}
	if (["zakladka", "poliart"].includes(shop.key)) {
		const product = schemas.find((n) => n["@type"] === "Product" && clean(n.name || "") === title && polishProductUrl(n.url || n.offers?.url || n.offers?.[0]?.url || String(n["@id"] || "").split("#")[0], shop) === safe);
		if (!product) return [];
		detail = detail || clean(product.description || "");
		const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
		if (offers.length !== 1 || !offers[0]) return [];
		const o = offers[0];
		if (o["@type"] === "AggregateOffer" || polishProductUrl(o.url || safe, shop) !== safe) return [];
		price = String(o.price ?? "");
		currency = o.priceCurrency || "";
		availability = o.availability || "";
		isbn = product.isbn || product.gtin13 || "";
		if (shop.key === "zakladka") {
			isbn = isbn || detail.match(/ISBN\s*:?\s*([\d-]{10,18})/i)?.[1]?.replace(/-/g, "") || "";
			condition = stateOf(detail.match(/Stan\s+([^.]*)\./i)?.[1] || "");
			paper = /\bksiążka\b|strony\s+\d+/i.test(detail) && /okładk/i.test(detail);
		} else {
			const tag = html.match(/<div\b[^>]*id=["']product-details["'][^>]*>/i)?.[0];
			let data;
			try {
				data = JSON.parse(attr$1(tag || "", "data-product"));
			} catch {
				return [];
			}
			if (polishProductUrl(data.link || "", shop) !== safe || clean(data.name || "") !== title || String(data.is_virtual) !== "0") return [];
			for (const f of data.features || []) fields.set(normalizeBookText(f.name || ""), clean(String(f.value || "")));
			paper = /^książka\b/i.test(fields.get("typ obiektu") || "");
			condition = data.condition === "used" ? "used" : data.condition === "new" ? "new" : "unknown";
			language = fields.get("ksiazki jezyk") || "";
			author = clean(element(main, /<div\b[^>]*class=["'][^"']*product-information[^"']*["'][^>]*>/i).match(/Autor:\s*([\s\S]*?)<\/h3>/i)?.[1] || "");
		}
	}
	if (!paper || /ebook|e-book|audiobook|\bmp3\b|plik do pobrania|zestaw figurek|plastic kit/i.test(title + " " + detail)) return [];
	const numeric = Number(price.replace(",", "."));
	if (!Number.isFinite(numeric) || numeric <= 0 || currency !== "PLN") return [];
	const match = classifyPaperBook(title, [b.title, b.pl || ""], {
		authors: bookAuthors(b),
		author,
		publisher,
		isbn
	});
	if (match.state === "rejected") return [];
	const offer = baseOffer(b, title, safe, shop.name, numeric, currency, condition, checked, true);
	if (!offer) return [];
	Object.assign(offer, {
		author,
		publisher,
		isbn,
		available: /\/(InStock|LimitedAvailability)$/.test(availability),
		availabilityKnown: /\/(InStock|LimitedAvailability|OutOfStock|SoldOut|Discontinued)$/.test(availability),
		matchStatus: condition === "unknown" ? "review" : match.state,
		matchReason: condition === "unknown" ? "Nie potwierdzono stanu egzemplarza. Sprawdź opis oferty." : match.reason
	});
	if (language) {
		offer.language = /^(pl|pol|polski|polish)(?:[-_]|$)/i.test(language) ? "PL" : /^(en|eng|angielski|english)(?:[-_]|$)/i.test(language) ? "EN" : "?";
		offer.languageVerified = offer.language !== "?";
		if (offer.language === "?") return [];
	}
	return [offer];
}
function recognizedPolishListing(html, key) {
	return !!{
		kroliczajama: /Wyniki wyszukiwania|Niestety nie znaleziono produktu!/i,
		hermeszaczytany: /Wyniki wyszukiwania|Niestety nie znaleziono produktu!/i,
		grochowski: /shop_product_list|Nie znaleziono produktów/,
		tomik: /<product-list\b|Nie znaleziono produktów/,
		zakladka: /woocommerce-no-products-found|woocommerce-result-count|class=["'][^"']*\bproducts\b/,
		podkarpacki: /Wyniki wyszukiwania|Brak produktów w wybranej kategorii/,
		poliart: /id=["'](?:products|js-product-list)["']/
	}[key]?.test(html);
}
//#endregion
//#region lib/polish-antiquarian-config.ts
var polishAntiquarianKeys = [
	"kroliczajama",
	"hermeszaczytany",
	"grochowski",
	"tomik",
	"zakladka",
	"podkarpacki",
	"poliart"
];
var polishAntiquarianQueries = {
	kroliczajama: "https://kroliczajama.pl/q/?keywords={q}",
	hermeszaczytany: "https://hermeszaczytany.pl/q/?keywords={q}",
	grochowski: "https://agrochowski.pl/pl/searchquery/{q}/1/full/5",
	tomik: "https://antykwariattomik.pl/pl/searchquery/{q}/1/full/5",
	zakladka: "https://antykwariat-zakladka.pl/sklep/?s={q}",
	podkarpacki: "https://www.antykwariatpodkarpacki.pl/szukaj.php?fraza={q}",
	poliart: "https://poliart.biz/szukaj?controller=search&s={q}"
};
//#endregion
//#region lib/additional-stores.ts
var listReaders = [
	"conroy",
	"poznan",
	"bliskiestrony",
	"authentic",
	"nws",
	"bookway",
	"kwadryga",
	"poczytaj"
];
var automaticAntiquarians = [
	"gryf",
	"blackbooks",
	"kulturawraca",
	"sobieski",
	"szarlatan",
	"adumaru",
	...listReaders
];
var newReaders = [
	"sobieski",
	"szarlatan",
	"adumaru",
	"lagano",
	"passioland",
	"jaskiniatrolla"
];
var antiquarianQueries = {
	conroy: "https://www.antykwariat-conroy.pl/advanced_search_result.php?search_in_description=1&keywords={q}",
	poznan: "https://www.antykwariat.pl/pl/searchquery/{q}/1/full/5",
	bliskiestrony: "https://bliskiestrony.eu/szukaj?s={q}",
	authentic: "https://www.antykwariat-authentic.pl/category/?q={q}",
	nws: "https://www.antykwariatnws.pl/index.php?action=antykwariat_wyszukiwarka&setsearch=1&szukamy=tak&tekst={q}",
	bookway: "https://bookway.pl/ksiazki?ksiazki={q}",
	kwadryga: "https://kwadryga.com/sklep/?woos={q}",
	sobieski: "https://antyksobieski.pl/product/search?query={q}",
	szarlatan: "https://szarlatan.pl/?post_type=product&s={q}",
	adumaru: "https://adumaru.pl/pl/searchquery/{q}/1/full/5"
};
var additionalStores = [
	...polishAntiquarianCandidates.map((shop) => ({
		...shop,
		used: true,
		search: polishAntiquarianQueries[shop.key]
	})),
	...antiquarianSources.map((shop) => ({
		...shop,
		manual: !automaticAntiquarians.includes(shop.key),
		used: true,
		mixed: true,
		search: antiquarianQueries[shop.key] || (shop.key === "gryf" ? shop.url + "search?q={q}" : shop.key === "blackbooks" ? shop.url + "module/iqitsearch/searchiqit?s={q}" : shop.key === "kulturawraca" ? shop.url + "pl/searchquery/{q}/1/full/5" : antiquarianSearch(shop.url)),
		manualReason: shop.name + ": automatyczny odczyt cen nie jest skonfigurowany. Wyszukaj tytuł w tym sklepie przez Google, sprawdź stan i dostępność, a konkretną ofertę dodaj ręcznie."
	})),
	{
		key: "poczytaj",
		name: "Poczytaj.pl",
		url: "https://www.poczytaj.pl/",
		search: "https://www.poczytaj.pl/index.php?akcja=pokaz_ksiazki&szukaj={q}"
	},
	{
		key: "vanaheim",
		name: "Vanaheim",
		url: "https://vanaheim.pl/pl/555-black-library",
		extraUrls: ["https://vanaheim.pl/pl/1130-warhammer-fantasy-pl"]
	},
	{
		key: "warhammer",
		name: "Warhammer.com",
		url: "https://www.warhammer.com/en-PL/black-library-lp",
		manual: true
	},
	{
		key: "hegemon",
		name: "Hegemon Shop",
		url: "https://hegemonshop.com/pl/313-ksiazki",
		search: "https://hegemonshop.com/pl/szukaj?controller=search&s={q}",
		englishFirst: true
	},
	{
		key: "mepel",
		name: "Mepel",
		url: "https://mepel.pl/ksiazki",
		search: "https://mepel.pl/pl/searchquery/{q}/1/full/5",
		englishFirst: true
	},
	{
		key: "panmysza",
		name: "Pan Mysza",
		url: "https://panmysza.pl/pl/c/Black-Library/686",
		search: "https://panmysza.pl/pl/searchquery/{q}/1/full/5",
		englishFirst: true
	},
	{
		key: "zagrajnik",
		name: "Zagrajnik",
		url: "https://zagrajnik.shop/pl/c/Ksiazki/121",
		search: "https://zagrajnik.shop/pl/searchquery/{q}/1/full/5",
		englishFirst: true
	},
	{
		key: "battlecult",
		name: "Battlecult",
		url: "https://battlecult.pl/",
		search: "https://battlecult.pl/pl/searchquery/{q}/1/full/5",
		englishFirst: true
	},
	{
		key: "osnowa",
		name: "Osnowa",
		url: "https://osnowa.pl/pl/c/Ksiazki-i-czasopisma/322",
		search: "https://osnowa.pl/pl/searchquery/{q}/1/full/5",
		englishFirst: true
	},
	{
		key: "tezeusz",
		name: "Tezeusz",
		url: "https://tezeusz.pl/szukaj?cid=3&szukaj=warhammer",
		search: "https://tezeusz.pl/szukaj?cid=3&szukaj={q}",
		mixed: true
	},
	{
		key: "graal",
		name: "Graal",
		url: "https://sklep-graal.pl/pl/c/Ksiazki-w-swiecie-Warhammera/606",
		search: "https://sklep-graal.pl/pl/searchquery/{q}/1/full/5",
		englishFirst: true
	},
	{
		key: "piekielko",
		name: "RPG Piekiełko",
		url: "https://rpg-piekielko.pl/pl/menu/ksiazki-powiesci-opowiadania-3069.html"
	},
	{
		key: "booksale",
		name: "Booksale",
		url: "https://booksale.pl/?_search_avail=1",
		search: "https://booksale.pl/index.php?do_search=true&search_query={q}"
	},
	{
		key: "smakliter",
		name: "SmakLiter",
		url: "https://smakliter.pl/fantastyka,kategoria-25778",
		search: "https://smakliter.pl/?filter={q}"
	},
	{
		key: "megaksiazki",
		name: "Megaksiążki",
		url: "https://www.megaksiazki.pl/1537-fantastyczno-naukowe?p=1",
		search: "https://www.megaksiazki.pl/wyszukiwanie?orderby=position&orderway=desc&search_query={q}",
		englishFirst: true
	},
	{
		key: "czytam",
		name: "Czytam.pl",
		url: "https://czytam.pl/fantastyka-i-horrory-1195",
		manual: true,
		manualReason: "Czytam.pl: wyszukiwanie ładuje wyniki dynamicznie; aktualnych cen nie potwierdzono. Otwórz dział i dodaj ofertę ręcznie."
	},
	{
		key: "2d6",
		name: "2d6",
		url: "https://www.2d6.pl/pl/menu/ksiazki-black-library-age-of-sigmar-551.html"
	},
	{
		key: "lagano",
		name: "Lagano",
		url: "https://lagano.pl/",
		search: "https://lagano.pl/?post_type=product&s={q}"
	},
	{
		key: "passioland",
		name: "PassioLand",
		url: "https://passioland.com/",
		search: "https://passioland.com/search?type=product&q={q}"
	},
	{
		key: "jaskiniatrolla",
		name: "Jaskinia Trolla",
		url: "https://jaskiniatrolla.pl/Warhammer-Chronicles-c677"
	}
];
var encodeQuery = (title, shop) => shop.key === "nws" ? [...title].map((c) => {
	const chars = "ĄĆĘŁŃÓŚŹŻąćęłńóśźż", bytes = [
		"A1",
		"C6",
		"CA",
		"A3",
		"D1",
		"D3",
		"A6",
		"AC",
		"AF",
		"B1",
		"E6",
		"EA",
		"B3",
		"F1",
		"F3",
		"B6",
		"BC",
		"BF"
	];
	const i = chars.indexOf(c);
	return i < 0 ? encodeURIComponent(c) : "%" + bytes[i];
}).join("") : encodeURIComponent(title);
var additionalSearchUrl = (b, shop) => shop.key === "jaskiniatrolla" && b.universe === "Age of Sigmar" ? "https://jaskiniatrolla.pl/Age-Of-Sigmar-c65" : shop.search ? shop.search.replace("{q}", encodeQuery(shop.englishFirst ? b.title : b.pl || b.title, shop)) : shop.url;
function additionalSearchUrls(b, shop) {
	const first = additionalSearchUrl(b, shop);
	if (shop.search && polishAntiquarianKeys.includes(shop.key)) {
		const titles = [...new Set([b.pl, b.title].filter((t) => !!t))];
		const author = bookAuthors(b)[0];
		const refined = author ? titles.filter((t) => normalizeBookText(t).split(" ").length <= 2).map((t) => shop.search.replace("{q}", encodeQuery(t + " " + author, shop))) : [];
		return [...new Set([
			...refined,
			first,
			...titles.map((t) => shop.search.replace("{q}", encodeQuery(t, shop)))
		])];
	}
	if (!shop.search || ![
		...listReaders,
		...polishAntiquarianKeys,
		"hegemon",
		"panmysza",
		"adumaru",
		"kulturawraca",
		"mepel",
		"zagrajnik",
		"battlecult",
		"osnowa",
		"graal",
		"megaksiazki"
	].includes(shop.key)) return [first];
	return [...new Set([first, ...[b.pl, b.title].filter(Boolean).map((title) => shop.search.replace("{q}", encodeQuery(title, shop)))])];
}
var attribute = (tag, name) => clean(tag.match(new RegExp("\\b" + name + "=[\"']([^\"']*)[\"']", "i"))?.[1] || "");
function productUrl(raw, shop) {
	if (polishAntiquarianKeys.includes(shop.key)) return polishProductUrl(raw, shop);
	try {
		const u = new URL(clean(raw), shop.url);
		if (u.origin !== new URL(shop.url).origin || u.username || u.password) return null;
		const patterns = {
			conroy: /^\/[^/]+-p-\d+\.html$/,
			nws: /^\/oferta-\d+-\d+-[^/]+\.html$/,
			bookway: /^\/ksiazka\/[^/]+$/,
			kwadryga: /^\/produkt\/[^/]+\/$/,
			authentic: /^\/[^/]+-p\d+$/,
			bliskiestrony: /^\/[^/]+\/\d+-[^/]+\.html$/,
			poczytaj: /^\/ksiazka\/[^/]+(?:,|%2C)\d+$/i
		};
		return (patterns[shop.key] ? patterns[shop.key].test(u.pathname) : shop.key === "lagano" ? /^\/ksiazki\/(?:[^/]+\/){2,}[^/]+\/$/.test(u.pathname) : shop.key === "szarlatan" ? /^\/katalog\/[^/]+\/$/.test(u.pathname) : shop.key === "sobieski" ? /^\/[^/]+\.html$/.test(u.pathname) : shop.key === "jaskiniatrolla" ? /^\/[^/]+-p\d+$/.test(u.pathname) : ["gryf", "passioland"].includes(shop.key) ? /^\/products\/[^/]+$/.test(u.pathname) : shop.key === "blackbooks" ? /^\/[^/]+\/\d+-[^/]+\.html$/.test(u.pathname) : ["piekielko", "2d6"].includes(shop.key) ? /^\/pl\/products\/[^/]+-\d+\.html$/.test(u.pathname) : shop.key === "booksale" ? /-p\d+$/.test(u.pathname) : shop.key === "smakliter" ? /,produkt-\d+$/.test(u.pathname) : shop.key === "megaksiazki" ? /^\/(?:[^/]+\/)?\d+-[^/]+\.html$/.test(u.pathname) : shop.key === "hegemon" ? /^\/pl\/[^/]+\/\d+-[^/]+\.html$/.test(u.pathname) : shop.key === "vanaheim" ? /\.html$/.test(u.pathname) : shop.key === "osnowa" ? /^\/pl\/p\/[^/]+\/\d+$/.test(u.pathname) || /^\/(?!pl$|ksiazki$|koszyk$)[^/]+$/.test(u.pathname) : ["mepel", "tezeusz"].includes(shop.key) ? /^\/[^/]+$/.test(u.pathname) && ![
			"/ksiazki",
			"/szukaj",
			"/koszyk",
			"/pl"
		].includes(u.pathname) : /^\/pl\/p\/[^/]+\/\d+$/.test(u.pathname)) ? u.origin + u.pathname : null;
	} catch {
		return null;
	}
}
function canonicalProductUrl(html, shop) {
	for (const m of html.matchAll(/<link\b[^>]*>/gi)) if (attribute(m[0], "rel") === "canonical") return productUrl(attribute(m[0], "href"), shop);
	return null;
}
function normalizeStoreListing(html, shop) {
	if (shop.key === "authentic" && /class=["'][^"']*list-empty/.test(html)) return html.replace(/<link\b[^>]*rel=["']next["'][^>]*>/gi, "");
	if (![
		"vanaheim",
		"hegemon",
		"blackbooks"
	].includes(shop.key) || !html.trimStart().startsWith("{")) return html;
	const data = JSON.parse(html);
	if (typeof data.rendered_products === "string") return Object.entries(data).filter(([key, value]) => key.startsWith("rendered_") && typeof value === "string").map(([, value]) => value).join("\n");
	if (Array.isArray(data.products) && data.products.length === 0) return "<div id=\"js-product-list\"></div>";
	throw Error("Nie rozpoznano publicznych wyników JSON sklepu.");
}
function discoverAdditionalProducts(html, b, shop) {
	html = normalizeStoreListing(html, shop);
	const urls = /* @__PURE__ */ new Set();
	if (newReaders.includes(shop.key)) {
		const canonical = canonicalProductUrl(html, shop), title = clean(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
		if (canonical && matches(b, title, true)) urls.add(canonical);
	}
	for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
		if (!matches(b, attribute(m[1], "title") || clean(m[2]) || (shop.key === "conroy" ? attribute(m[2].match(/<img\b[^>]*>/i)?.[0] || "", "alt") : ""), true)) continue;
		const url = productUrl(attribute(m[1], "href"), shop);
		if (url) urls.add(url);
	}
	return [...urls];
}
function schemas(html) {
	const out = [];
	for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) try {
		const n = JSON.parse(m[1]);
		out.push(...Array.isArray(n) ? n : n["@graph"] || [n]);
	} catch {}
	return out;
}
function newSourceProductNodes(html, shop, pageUrl, nodes) {
	const safe = productUrl(pageUrl, shop);
	const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
	if (!safe || !heading) return [];
	const title = clean(heading[1]);
	const dom = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
	if (/\b(?:zestaw|pakiet|komplet)\b|\d+\s+(?:rzadkich\s+)?(?:tomów|wol\.)/i.test(title)) return [];
	const detail = shop.key === "szarlatan" ? clean(dom.match(/<div[^>]*id=["']tab-description["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "") : shop.key === "sobieski" ? clean(dom.match(/<div[^>]*id=["']description-long["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "") : shop.key === "adumaru" ? clean(dom.match(/<div[^>]*itemprop=["']description["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "") : "";
	if (shop.key === "adumaru") {
		const main = dom.slice(dom.indexOf(heading[0]));
		const description = detail;
		if (!/\bstron\s+\d+|okładka\s+(miękka|twarda)/i.test(description)) return [];
		const priceTag = main.match(/<[^>]*itemprop=["']price["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
		const price = priceTag ? attribute(priceTag[0], "content") || clean(priceTag[1]) : "";
		const currency = attribute(main.match(/<[^>]*itemprop=["']priceCurrency["'][^>]*>/i)?.[0] || "", "content");
		const availability = attribute(main.match(/<[^>]*itemprop=["']availability["'][^>]*>/i)?.[0] || "", "href");
		const condition = /stan\s*:?\s*now[ay]/i.test(description) ? "NewCondition" : /książka stan|pożółk|ślad po|przybrudzeni|sfatygowan/i.test(description) ? "UsedCondition" : "";
		return [{
			"@type": "Book",
			name: title,
			url: safe,
			description,
			offers: {
				url: safe,
				price: price.replace(",", "."),
				priceCurrency: currency,
				availability,
				itemCondition: condition
			}
		}];
	}
	return nodes.filter((n) => n["@type"] === "Product" || n["@type"] === "Book").filter((n) => {
		const identity = n.url || n["@id"] || n.offers?.url;
		return clean(n.name || "") === title && (!identity || productUrl(String(identity).split("#")[0], shop) === safe);
	}).map((n) => {
		n = { ...n };
		const description = detail || clean(n.description || "");
		if (!n.gtin13 && !n.gtin && !n.isbn) {
			const isbn = description.match(/ISBN\s*:?\s*((?:97[89])[\d-]{10,17})/i)?.[1];
			if (isbn) n.isbn = isbn.replace(/-/g, "");
		}
		if (["szarlatan", "sobieski"].includes(shop.key)) {
			if (/\d+\s*s\.|\bstron\s*:?\s*\d+|\bpp?\.\s*\d+/i.test(description)) n["@type"] = "Book";
			if (/copernicus/i.test(description)) n.publisher = "Copernicus Corporation";
			const condition = /stan\s*:?\s*now[ay]|nieczytan/i.test(description) ? "NewCondition" : /\b(?:s|st)\.\s*(?:bdb|db)|stan.*(?:bdb|db|idealn)|sfatygowan|Condition:\s*(?:Very good|Good|Used)/i.test(description) ? "UsedCondition" : "";
			n.offers = (Array.isArray(n.offers) ? n.offers : [n.offers]).filter(Boolean).map((o) => ({
				...o,
				itemCondition: condition
			}));
		}
		if (shop.key === "passioland" && /Język:\s*polski/i.test(description)) n.inLanguage = "pl";
		return n;
	});
}
function sourceListProductNodes(html, shop, pageUrl, nodes) {
	const safe = productUrl(pageUrl, shop);
	if (!safe) return [];
	if (shop.key === "bookway") try {
		const settings = JSON.parse(html.match(/<script[^>]*data-drupal-selector=["']drupal-settings-json["'][^>]*>([\s\S]*?)<\/script>/i)?.[1] || "");
		const products = Object.values(settings.addToCart || {});
		if (products.length !== 1) return [];
		const product = products[0];
		if (Object.keys(product.variations || {}).length !== 1) return [];
		return Object.values(product.variations || {}).map((v) => {
			const state = (product.attributeOptions?.[v.uuid]?.attributes || []).flatMap((a) => a.values || []).find((a) => a.attribute_value_id === v.attribute_stan_ksiazki);
			const condition = /nieużywan|nowa książka/i.test(state?.field_opis || "") ? "NewCondition" : /używan/i.test(state?.field_opis || "") ? "UsedCondition" : "";
			return {
				"@type": "Product",
				name: v.title,
				url: safe,
				isbn: v.field_upc?.[0],
				offers: {
					url: safe,
					price: v.price?.number,
					priceCurrency: v.price?.currency_code,
					itemCondition: condition,
					availability: Number(v.field_stock) > 0 && v.field_wstrzymany === false ? "https://schema.org/InStock" : v.field_stock != null ? "https://schema.org/OutOfStock" : ""
				}
			};
		});
	} catch {
		return [];
	}
	const dom = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
	const heading = shop.key === "conroy" ? dom.match(/<h4[^>]*class=["']titleProduct["'][^>]*>([\s\S]*?)<\/h4>/i) : dom.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
	if (!heading) return [];
	const title = clean(heading[1]);
	if (/\b(?:zestaw|pakiet|komplet)\b|\d+\s+tomów/i.test(title)) return [];
	const start = heading.index;
	let main = dom.slice(start);
	const boundary = main.search(/<section[^>]*class=["'][^"']*(?:products-slider|related)|<div[^>]*id=["']box_productrelated|<h2[^>]*class=["']viewed_title|<!--.*(?:Polecane|Nowości)/i);
	if (boundary >= 0) main = main.slice(0, boundary);
	if (shop.key === "conroy") {
		const end = main.indexOf("</form>");
		if (end >= 0) main = main.slice(0, end);
		const next = main.slice(heading[0].length).search(/<h4[^>]*class=["']titleProduct["']/i);
		if (next >= 0) main = main.slice(0, next + heading[0].length);
	}
	const text = clean(main);
	const description = shop.key === "poznan" ? clean(main.match(/<div[^>]*itemprop=["']description["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "") : text;
	const isbn = description.match(/ISBN\s*:?\s*((?:97[89])[\d-]{10,17})/i)?.[1]?.replace(/-/g, "");
	if (!(!!isbn || /\bstron\s*:?\s*\d+|\bs\.\s*\d+|Ilość stron\s*\d+|okładka\s+(miękka|twarda)|książka w oprawie/i.test(description))) return [];
	const condition = /stan\s*:?[^.]{0,50}(?:książka nowa|nieczytan)|stan\s*:?\s*now[ay]/i.test(description) ? "NewCondition" : /stan\s*:?\s*(?:dobry|bardzo dobry|bdb|db)|pożółk|otarci|przybrudzon|ślad.{0,15}używan/i.test(description) ? "UsedCondition" : "";
	if ([
		"conroy",
		"nws",
		"poznan"
	].includes(shop.key)) {
		const priceTag = shop.key === "conroy" ? main.match(/<span[^>]*id=["']nowaCena["'][^>]*>([\s\S]*?)<\/span>/i) : shop.key === "nws" ? main.match(/<span[^>]*class=["']book_price2["'][^>]*>([\s\S]*?)<\/span>/i) : main.match(/<[^>]*itemprop=["']price["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
		return [{
			"@type": "Book",
			name: title,
			url: safe,
			isbn,
			description,
			offers: {
				url: safe,
				price: priceTag ? clean(priceTag[1]).replace(/[^\d,.]/g, "").replace(",", ".") : "",
				priceCurrency: shop.key === "poznan" ? attribute(main.match(/<[^>]*itemprop=["']priceCurrency["'][^>]*>/i)?.[0] || "", "content") : priceTag && /zł|PLN/.test(clean(priceTag[1])) ? "PLN" : "",
				itemCondition: condition,
				availability: shop.key === "poznan" ? attribute(main.match(/<[^>]*itemprop=["']availability["'][^>]*>/i)?.[0] || "", "href") : shop.key === "nws" ? /class=["']ad_basket_box["']/.test(main) ? "https://schema.org/InStock" : "" : /<button[^>]*class=["'][^"']*buyNow[^"']*["'][^>]*>(?:KUP TERAZ)/i.test(main) ? "https://schema.org/InStock" : ""
			}
		}];
	}
	return nodes.filter((n) => n["@type"] === "Product" || n["@type"] === "Book").filter((n) => {
		const identity = n.url || n["@id"] || n.offers?.url;
		return (!identity || productUrl(String(identity).split("#")[0], shop) === safe) && (clean(n.name || "") === title || shop.key === "kwadryga" && clean(n.name || "").startsWith(title + " |"));
	}).map((n) => {
		let state = condition;
		if (shop.key === "bliskiestrony") state = attribute(main.match(/<link[^>]*itemprop=["']itemCondition["'][^>]*>/i)?.[0] || "", "href");
		if (shop.key === "poczytaj" && /Cena wydawcy:/.test(text) && /pozycja niedostępna/.test(text)) return null;
		return {
			...n,
			"@type": "Book",
			name: title,
			isbn: isbn || n.isbn || n.gtin13,
			url: safe,
			offers: (Array.isArray(n.offers) ? n.offers : [n.offers]).filter(Boolean).map((o) => ({
				...o,
				url: o.url || safe,
				itemCondition: shop.mixed ? state : o.itemCondition
			}))
		};
	}).filter(Boolean);
}
function antiquarianProductNodes(html, shop, pageUrl) {
	const nodes = schemas(html);
	if (listReaders.includes(shop.key)) return sourceListProductNodes(html, shop, pageUrl, nodes);
	if (newReaders.includes(shop.key)) return newSourceProductNodes(html, shop, pageUrl, nodes);
	if (![
		"gryf",
		"blackbooks",
		"kulturawraca"
	].includes(shop.key)) return nodes;
	const safe = productUrl(pageUrl, shop);
	if (shop.key === "kulturawraca") {
		const fragments = nodes.filter((n) => productUrl(n["@id"] || "", shop) === safe);
		const merged = { offers: {} };
		for (const n of fragments) {
			const offers = merged.offers;
			Object.assign(merged, n);
			merged.offers = {
				...offers,
				...n.offers
			};
		}
		if (merged.name) {
			const text = clean(html.match(/<product-short-description\b[^>]*>([\s\S]*?)<\/product-short-description>/i)?.[1] || "");
			const property = (name) => merged.additionalProperty?.find((p) => p.name === name)?.value;
			merged.gtin13 = text.match(/EAN:\s*(97[89]\d{10})/)?.[1] || property("ISBN");
			merged.author = property("Autor") || merged.author;
			merged.publisher = property("Wydawnictwo") || merged.publisher;
			merged.offers.itemCondition = /Stan:\s*Używany/i.test(text) ? "UsedCondition" : /Stan:\s*Nowy/i.test(text) ? "NewCondition" : "";
			merged.inLanguage = /Język publikacji:\s*polski/i.test(text) ? "pl" : /Język publikacji:\s*angielski/i.test(text) ? "en" : void 0;
			return [merged];
		}
		return [];
	}
	if (shop.key === "blackbooks") {
		const tag = html.match(/<div\b[^>]*id=["']product-details["'][^>]*>/i)?.[0] || "";
		let details;
		try {
			details = JSON.parse(attribute(tag, "data-product"));
		} catch {
			return [];
		}
		for (const n of nodes) {
			if (n["@type"] !== "Product" || productUrl(n.offers?.url || "", shop) !== safe) continue;
			const feature = (key) => details.features?.find((f) => f.name === key)?.value;
			n.isbn = feature("ISBN");
			n.author = feature("Autor")?.trim();
			n.publisher = feature("Wydawnictwo");
			n.offers.itemCondition = details.condition === "used" ? "UsedCondition" : details.condition === "new" ? "NewCondition" : "";
		}
		return nodes;
	}
	for (const n of nodes) {
		if (n["@type"] !== "Product") continue;
		const state = clean(n.description || "").match(/Stan:\s*(Nowy|Nowa|Używan[ay])/i)?.[1];
		if (state) n.itemCondition = /^Now/i.test(state) ? "NewCondition" : "UsedCondition";
	}
	return nodes;
}
function structuredProducts(html, b, checked, shop, pageUrl) {
	const out = [];
	const dom = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
	for (const n of antiquarianProductNodes(html, shop, pageUrl)) {
		const types = (Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]]).map((t) => String(t).split("/").at(-1) || "");
		if (!types.some((t) => ["Product", "Book"].includes(t)) || !n.name) continue;
		const title = clean(n.name);
		if (!matches(b, title, true)) continue;
		const isbn = String(n.isbn || n.gtin13 || n.gtin || String(n.productID || "").match(/97[89]\d{10}/)?.[0] || "");
		if (!(types.includes("Book") || /^97[89]\d{10}$/.test(isbn) || /paperback|hardback|hardcover|miękka okładka|twarda okładka|\b(?:HB|PB)\b/i.test(title)) || /^\d{13}$/.test(isbn) && !/^97[89]/.test(isbn)) continue;
		const author = typeof n.author === "string" ? n.author : n.author?.name;
		const publisher = typeof n.publisher === "string" ? n.publisher : n.publisher?.name || n.brand?.name || "";
		const match = classifyPaperBook(title, [b.title, b.pl || ""], {
			authors: bookAuthors(b),
			author,
			publisher,
			isbn
		});
		if (match.state === "rejected") continue;
		if (n.inLanguage && !/^(pl|pol|polish|en|eng|english)([-_].*)?$/i.test(n.inLanguage)) continue;
		for (const data of Array.isArray(n.offers) ? n.offers : [n.offers]) {
			if (!data) continue;
			let price = data.price;
			let url = productUrl(data.url || n.url || String(n["@id"] || "").split("#")[0] || pageUrl, shop);
			let condition = data.itemCondition || n.itemCondition || "";
			let availability = data.availability || "";
			if (shop.key === "tezeusz" && data["@type"] === "AggregateOffer") {
				const current = clean(dom.match(/<span[^>]*class=["'][^"']*single-product-add-to-cart__price--current[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || "").replace(/[^\d,.]/g, "").replace(",", ".");
				if (Number(data.offerCount) !== 1 || Number(data.lowPrice) !== Number(data.highPrice) || !current || Number(current) !== Number(data.lowPrice)) continue;
				price = data.lowPrice;
				const primary = dom.slice(dom.search(/<h1\b/i), dom.search(/<h1\b/i) + 12e3);
				const state = clean(primary.match(/Stan:\s*<span[^>]*>([^<]*)/i)?.[1] || "");
				condition = /^używana$/i.test(state) ? "UsedCondition" : /^nowa$/i.test(state) ? "NewCondition" : "";
				const button = primary.match(/<button[^>]*data-url=["']\/koszyk\/dodaj["'][^>]*>/i)?.[0];
				if (button && !/\bdisabled\b/.test(button)) availability = "https://schema.org/InStock";
			}
			if (shop.key === "tezeusz") {
				const canonicalTag = [...html.matchAll(/<link\b[^>]*>/gi)].find((m) => attribute(m[0], "rel").split(/\s+/).includes("canonical"))?.[0];
				url = (canonicalTag ? productUrl(attribute(canonicalTag, "href"), shop) : null) || productUrl(n.url || "", shop) || productUrl(pageUrl, shop) || url;
			}
			if (price == null || !data.priceCurrency || !url) continue;
			const state = /NewCondition$/.test(condition) ? "new" : /UsedCondition$/.test(condition) ? "used" : shop.mixed ? "unknown" : "new";
			const offer = baseOffer(b, title, url, shop.name, Number(price), data.priceCurrency, state, checked, true);
			if (!offer) continue;
			Object.assign(offer, {
				author,
				publisher,
				isbn,
				matchStatus: state === "unknown" ? "review" : match.state,
				matchReason: state === "unknown" ? "Stan egzemplarza nie jest potwierdzony. Sprawdź ofertę." : match.reason,
				available: /\/(InStock|LimitedAvailability)$/.test(availability),
				availabilityKnown: /\/(InStock|LimitedAvailability|OutOfStock|SoldOut|Discontinued)$/.test(availability)
			});
			if (n.inLanguage) {
				const lang = String(n.inLanguage).toLowerCase();
				offer.language = /^(pl|pol|polish)([-_]|$)/.test(lang) ? "PL" : /^(en|eng|english)([-_]|$)/.test(lang) ? "EN" : "?";
				offer.languageVerified = offer.language !== "?";
			}
			out.push(offer);
		}
	}
	return [...new Map(out.map((o) => [o.id, o])).values()];
}
function parseAdditionalProduct(html, b, checked, shop, url) {
	if (polishAntiquarianKeys.includes(shop.key)) return parsePolishAntiquarianProduct(html, b, checked, shop, url);
	const safe = productUrl(url, shop);
	if (!safe) return [];
	const structured = structuredProducts(html, b, checked, shop, url);
	if (structured.length) return structured;
	if (shop.mixed || listReaders.includes(shop.key)) return [];
	const originalHTML = html;
	html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
	const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
	if (!heading) return [];
	const title = clean(heading[1]);
	if (!matches(b, title, true)) return [];
	const remaining = html.slice(heading.index, heading.index + 3e4);
	const related = remaining.search(/<[^>]+itemtype=["']https?:\/\/schema.org\/Product["']/i);
	const main = related < 0 ? remaining : remaining.slice(0, related);
	const priceTag = main.match(/<[^>]+itemprop=["']price["'][^>]*>([^<]*)/i);
	let price = priceTag ? attribute(priceTag[0], "content") || clean(priceTag[1]) : "";
	let currency = attribute(main.match(/<[^>]+itemprop=["']priceCurrency["'][^>]*>/i)?.[0] || "", "content");
	let availability = attribute(main.match(/<[^>]+itemprop=["']availability["'][^>]*>/i)?.[0] || "", "href");
	let publisher = attribute(main.match(/<[^>]+itemprop=["']brand["'][^>]*>/i)?.[0] || "", "content");
	let isbn = attribute(main.match(/<[^>]+itemprop=["']gtin(?:13)?["'][^>]*>/i)?.[0] || "", "content");
	if (shop.key === "hegemon" && !isbn && canonicalProductUrl(originalHTML, shop) === safe) isbn = safe.match(/-(97[89]\d{10})\.html$/)?.[1] || "";
	let description = clean(main.match(/<div[^>]+itemprop=["']description["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "");
	for (const n of schemas(originalHTML)) {
		const id = n["@id"];
		if (!id || productUrl(id, shop) !== safe) continue;
		if (n.description) description = clean(n.description);
		if (n.brand) publisher = typeof n.brand === "string" ? n.brand : n.brand.name || publisher;
		const o = n.offers;
		if (o && productUrl(o["@id"] || o.url || id, shop) === safe) {
			if (o.price != null) {
				price = String(o.price);
				currency = o.priceCurrency || currency;
			}
			if (o.availability) availability = o.availability;
		}
	}
	if (shop.key === "megaksiazki") {
		const visible = main.slice(main.search(/class=["'][^"']*\bour_price\b[^"']*["']/i));
		price = clean(visible.match(/<span[^>]*id=["']our_price_display["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || "").replace(/[^\d,.]/g, "").replace(",", ".");
		currency = clean(visible.match(/<span[^>]*id=["']our_price_currency["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || "") === "zł" ? "PLN" : "";
		const raw = originalHTML.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i)?.[1] || "";
		try {
			const encoded = raw.match(/"description"\s*:\s*("(?:[^"\\]|\\.)*")/)?.[1];
			if (encoded) description = clean(JSON.parse(encoded));
		} catch {}
		if (/po czesku|po słowacku|po niemiecku/i.test(title)) return [];
	}
	if (shop.key === "osnowa" && !availability) {
		const notifier = [...main.matchAll(/<availability-notifier-btn\b[^>]*>/gi)].find((m) => attribute(m[0], "product-name") === title);
		const id = safe.match(/\/(\d+)$/)?.[1] || (notifier ? attribute(notifier[0], "product-id") : "");
		if ([...main.matchAll(/<buy-button\b[^>]*>/gi)].find((m) => id && attribute(m[0], "is-buyable") === "1" && attribute(m[0], "product-id") === id)) availability = "https://schema.org/InStock";
		else if (notifier && !/\bhidden\b/.test(notifier[0])) availability = "https://schema.org/OutOfStock";
	}
	if (/^\d{13}$/.test(isbn) && !/^97[89]/.test(isbn) || /figurka wymaga|wieloczęściowy zestaw plastikowy|plastic kit|miniature requires|zestaw zawiera \d+ plastik/i.test(description)) return [];
	if (!(shop.key === "megaksiazki" && /itemtype=["']https?:\/\/schema.org\/Book["']/.test(main) || /paperback|hardback|hardcover|książk|ksiazk|novel|black library|\b(?:HB|PB|book)\b/i.test(title + " " + description) || /^97[89]\d{10}$/.test(isbn) || shop.key === "hegemon" && /\/black-library\//.test(safe))) return [];
	const offer = baseOffer(b, title, safe, shop.name, Number(price.replace(",", ".")), currency, "new", checked, true);
	if (!offer || ![
		"PLN",
		"EUR",
		"GBP",
		"USD"
	].includes(currency)) return [];
	const match = classifyPaperBook(title, [b.title, b.pl || ""], {
		authors: bookAuthors(b),
		publisher,
		isbn
	});
	if (match.state === "rejected") return [];
	Object.assign(offer, {
		publisher,
		isbn,
		matchStatus: match.state,
		matchReason: match.reason,
		available: /\/(InStock|LimitedAvailability)$/.test(availability),
		availabilityKnown: /\/(InStock|LimitedAvailability|OutOfStock|SoldOut|Discontinued)$/.test(availability)
	});
	return [offer];
}
var categories = /* @__PURE__ */ new Map();
async function additionalStoreOffers(b, checked, shop, read) {
	if (shop.manual) return {
		offers: [],
		manual: true,
		coverage: shop.manualReason || "Warhammer.com: katalog dynamiczny. Otwórz dział i dodaj cenę papierowej książki ręcznie; automatycznych cen nie potwierdzono."
	};
	const listingUrls = [...new Set([...additionalSearchUrls(b, shop), ...shop.extraUrls || []])];
	const urls = /* @__PURE__ */ new Set();
	let listingFailures = 0;
	let listingError;
	let pagePartial = false;
	let pagesRead = 0;
	const pageReasons = [];
	const listingProducts = await runLimited(listingUrls.map((listing) => async () => {
		const urls = /* @__PURE__ */ new Set();
		try {
			const listingResult = await readSearchPages(listing, async (url) => {
				if (shop.search) return normalizeStoreListing(await read(url), shop);
				let cached = categories.get(url);
				if (!cached || cached.until < Date.now()) {
					cached = {
						until: Date.now() + 12e4,
						promise: read(url)
					};
					categories.set(url, cached);
					cached.promise.catch(() => {
						if (categories.get(url) === cached) categories.delete(url);
					});
				}
				return normalizeStoreListing(await cached.promise, shop);
			});
			pagePartial ||= listingResult.partial;
			if (listingResult.partial) pageReasons.push(listingResult.coverage);
			pagesRead += listingResult.pages.length;
			for (const page of listingResult.pages) {
				const html = normalizeStoreListing(page.html, shop);
				const discovered = discoverAdditionalProducts(html, b, shop);
				if (polishAntiquarianKeys.includes(shop.key) && !recognizedPolishListing(html, shop.key)) throw Error("Nie rozpoznano wyników wyszukiwarki antykwariatu.");
				if (listReaders.includes(shop.key)) {
					if (!{
						conroy: /productListing|Brak produktów|class=["']titleProduct["']/,
						poznan: /shop_product_list|Nie znaleziono produktów/,
						bliskiestrony: /id=["'](?:js-product-list|products)|Nie znaleziono/,
						authentic: /list-empty|mod-products-list|Nie znaleziono wyników/,
						nws: /WYNIKI WYSZUKIWANIA|brak wyników/i,
						bookway: /Ojej, brak wyników|views-row|view-ksiazki/,
						kwadryga: /woocommerce-products-header|woocommerce-no-products-found|class=["'][^"']*products/,
						poczytaj: /Wyniki wyszukiwania|wynik.{0,20}wyszuk|class=["'][^"']*(?:produkt|produkty)/i
					}[shop.key].test(html) && !discovered.length) throw Error("Nie rozpoznano strony wyników sklepu.");
				}
				if (newReaders.includes(shop.key)) {
					if (!(shop.key === "lagano" ? /Wyniki wyszukiwania produktów|product-card__title/.test(html) : shop.key === "szarlatan" ? /woocommerce-products-header|woocommerce-no-products-found/.test(html) : shop.key === "sobieski" ? /class=["'][^"']*product-list|id=["']no-results-notice/.test(html) : shop.key === "adumaru" ? /class=["']shop_product_list|Shop.pageType = 'shop_product_list'/.test(html) : shop.key === "passioland" ? /id=["']ProductGridContainer|template-search__results/.test(html) : /mod-products-list-page/.test(html)) && !(canonicalProductUrl(html, shop) && /<h1\b/i.test(html))) throw Error("Nie rozpoznano strony wyników sklepu.");
				}
				if ([
					"gryf",
					"blackbooks",
					"kulturawraca"
				].includes(shop.key)) {
					if (!(shop.key === "gryf" ? /class=["'][^"']*template-search|id=["']ProductGridContainer/.test(html) : shop.key === "blackbooks" ? /id=["']js-product-list|id=["']products/.test(html) : /Lista produktów|product-list|Nie znaleziono produktów|nie ma obecnie żadnych produktów/i.test(html))) throw Error("Unrecognized search response");
				}
				if ([
					"panmysza",
					"mepel",
					"zagrajnik",
					"battlecult",
					"osnowa",
					"graal"
				].includes(shop.key) && !discovered.length && !/shop_product_list|Shop.pageType|Lista produktów|product-list|Nie znaleziono produktów|nie ma obecnie żadnych produktów/i.test(html)) throw Error("Nie rozpoznano strony wyników sklepu.");
				if (shop.key === "hegemon" && !discovered.length && !/id=["'](?:js-product-list|products)|class=["'][^"']*product-miniature|Nie znaleziono|brak wynik/i.test(html)) throw Error("Nie rozpoznano strony wyników Hegemona.");
				for (const url of discovered) urls.add(url);
			}
		} catch (e) {
			listingFailures++;
			listingError = e;
		}
		return [...urls];
	}), 2);
	for (const products of listingProducts) for (const url of products) urls.add(url);
	const offers = [];
	let failures = listingFailures;
	let unconfirmed = 0;
	let productsRead = 0;
	let lastError = listingError;
	const names = [b.pl, b.title].filter((value) => !!value).map(normalizeBookText);
	const score = (url) => {
		let decoded = url;
		try {
			decoded = decodeURIComponent(url);
		} catch {}
		const text = " " + normalizeBookText(decoded) + " ";
		return (polishAntiquarianKeys.includes(shop.key) ? (/\bwarhammer\b/.test(text) ? 500 : 0) + Math.max(0, ...bookAuthors(b).map((author) => normalizeBookText(author).split(" ").filter((word) => word.length > 3 && text.includes(" " + word + " ")).length * 50)) : 0) + Math.max(0, ...names.map((name) => text.includes(" " + name + " ") ? 100 + name.length : name.split(" ").filter((word) => word.length > 2 && text.includes(" " + word + " ")).length));
	};
	await runLimited([...urls].map((url, index) => ({
		url,
		index,
		score: score(url)
	})).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 9).map(({ url }) => async () => {
		try {
			const html = await read(url);
			productsRead++;
			const rows = parseAdditionalProduct(html, b, checked, shop, url);
			if (!rows.length) unconfirmed++;
			offers.push(...rows);
		} catch (e) {
			failures++;
			lastError = e;
		}
	}), 2);
	if (!offers.length && lastError) throw lastError;
	return {
		offers: [...new Map(offers.map((o) => [o.id, o])).values()],
		partial: pagePartial || failures > 0 || unconfirmed > 0 || urls.size > 9,
		coverage: `Odczytano ${pagesRead} stron wyszukiwania lub działu (do 3 stron na zapytanie; tytuł PL i EN, jeśli dostępne) i ${productsRead} produktów. ${pageReasons.join(" ")}${urls.size > 9 ? ` Limit produktów: sprawdzono 9 z ${urls.size} kandydatów.` : ""}${failures ? ` Błędy odczytu: ${failures}${lastError instanceof Error ? " (" + lastError.message + ")" : ""}.` : ""}${unconfirmed ? ` Nie potwierdzono ceny lub zgodności papierowej książki dla ${unconfirmed} produktów; nie dodano ich do porównania.` : ""} Brak dopasowań nie potwierdza braku książki w całym sklepie.`
	};
}
//#endregion
//#region lib/physical-scan-ids.json
var physical_scan_ids_default = [
	"f0001",
	"f0002",
	"f0003",
	"f0004",
	"f0005",
	"f0006",
	"f0007",
	"f0008",
	"f0009",
	"f0010",
	"f0011",
	"f0012",
	"f0045",
	"f0046",
	"f0047",
	"f0058",
	"f0059",
	"f0288",
	"f0071",
	"f0072",
	"f0073",
	"f0082",
	"f0114",
	"f0115",
	"f0013",
	"f0014",
	"f0015",
	"f0016",
	"f0017",
	"f0042",
	"f0043",
	"f0044",
	"f0048",
	"f0049",
	"f0493",
	"f0050",
	"f0051",
	"f0052",
	"f0053",
	"f0054",
	"f0055",
	"f0292",
	"f0293",
	"f0060",
	"f0061",
	"f0062",
	"f0063",
	"f0064",
	"f0065",
	"f0066",
	"f0067",
	"f0068",
	"f0069",
	"f0070",
	"f0076",
	"f0077",
	"f0078",
	"f0083",
	"f0084",
	"f0085",
	"f0087",
	"f0088",
	"f0089",
	"f0092",
	"f0093",
	"f0094",
	"f0095",
	"f0096",
	"f0099",
	"f0102",
	"f0103",
	"f0104",
	"f0287",
	"f0107",
	"f0108",
	"f0109",
	"f0110",
	"f0111",
	"f0112",
	"f0113",
	"f0116",
	"f0280",
	"f0117",
	"f0118",
	"f0119",
	"f0120",
	"f0121",
	"f0122",
	"f0284",
	"f0285",
	"f0124",
	"f0125",
	"f0126",
	"f0286",
	"f0130",
	"f0131",
	"f0132",
	"f0133",
	"f0134",
	"f0282",
	"f0283",
	"f0141",
	"f0142",
	"f0144",
	"f0145",
	"f0146",
	"f0147",
	"f0290",
	"f0154",
	"f0155",
	"f0156",
	"f0157",
	"f0158",
	"f0159",
	"f0160",
	"f0163",
	"f0164",
	"f0165",
	"f0494",
	"f0166",
	"f0167",
	"f0168",
	"f0169",
	"f0170",
	"f0171",
	"f0172",
	"f0173",
	"f0174",
	"f0175",
	"f0176",
	"f0177",
	"f0178",
	"f0179",
	"f0182",
	"f0183",
	"f0184",
	"f0275",
	"f0188",
	"f0189",
	"f0190",
	"f0276",
	"f0192",
	"f0193",
	"f0194",
	"f0195",
	"f0196",
	"f0277",
	"f0199",
	"f0200",
	"f0201",
	"f0279",
	"f0206",
	"f0207",
	"f0208",
	"f0278",
	"f0209",
	"f0210",
	"f0213",
	"f0214",
	"f0215",
	"f0495",
	"f0216",
	"f0217",
	"f0496",
	"f0289",
	"f0218",
	"f0219",
	"f0220",
	"f0221",
	"f0222",
	"f0223",
	"f0224",
	"f0225",
	"f0291",
	"f0497",
	"f0281",
	"f0235",
	"f0236",
	"f0237",
	"f0238",
	"f0239",
	"f0240",
	"f0241",
	"f0498",
	"f0248",
	"f0249",
	"f0250",
	"f0251",
	"f0252",
	"f0253",
	"f0259",
	"f0260",
	"f0261",
	"f0262",
	"f0263",
	"f0264",
	"f0265",
	"f0266",
	"f0267",
	"f0268",
	"f0269",
	"f0270",
	"f0271",
	"f0272",
	"f0273",
	"f0274",
	"f0022",
	"f0303",
	"f0294",
	"f0295",
	"f0296",
	"f0297",
	"f0298",
	"f0299",
	"f0300",
	"f0301",
	"f0302",
	"f0499",
	"f0500",
	"f0304",
	"f0305",
	"f0306",
	"f0307",
	"f0402",
	"f0318",
	"f0319",
	"f0320",
	"f0321",
	"f0322",
	"f0324",
	"f0325",
	"f0326",
	"f0327",
	"f0328",
	"f0329",
	"f0330",
	"f0333",
	"f0334",
	"f0394",
	"f0335",
	"f0336",
	"f0337",
	"f0339",
	"f0340",
	"f0341",
	"f0342",
	"f0343",
	"f0344",
	"f0345",
	"f0346",
	"f0347",
	"f0349",
	"f0350",
	"f0351",
	"f0352",
	"f0353",
	"f0354",
	"f0355",
	"f0356",
	"f0357",
	"f0358",
	"f0359",
	"f0360",
	"f0361",
	"f0362",
	"f0363",
	"f0364",
	"f0365",
	"f0366",
	"f0367",
	"f0368",
	"f0369",
	"f0370",
	"f0371",
	"f0372",
	"f0373",
	"f0374",
	"f0375",
	"f0376",
	"f0377",
	"f0378",
	"f0379",
	"f0380",
	"f0382",
	"f0386",
	"f0387",
	"f0389",
	"f0390",
	"f0391",
	"f0395",
	"f0397",
	"f0398",
	"f0399",
	"f0401",
	"f0501",
	"f0502",
	"f0403",
	"f0404",
	"f0405",
	"f0406",
	"f0407",
	"f0408",
	"f0409",
	"f0411",
	"f0412",
	"f0413",
	"f0416",
	"f0417",
	"f0418",
	"f0503",
	"f0348"
];
//#endregion
//#region lib/catalog.ts
var catalog = books_default;
var activeCatalog = catalog.filter((book) => book.catalogCurrent !== false).sort((a, b) => (a.workId || a.id).localeCompare(b.workId || b.id));
activeCatalog.length, catalog.length, physical_scan_ids_default.length, catalog.filter((book) => book.catalogCurrent === false).length, activeCatalog.length - physical_scan_ids_default.length;
new Set(physical_scan_ids_default);
var norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").replace(/[^a-z0-9]+/g, " ").trim();
var vintedSearchUrl = (title) => "https://www.vinted.pl/catalog/2312-books?search_text=" + encodeURIComponent(title);
var searchLinks = (b) => [
	{
		name: "Allegro",
		url: "https://allegro.pl/listing?string=" + encodeURIComponent((b.pl || b.title) + " książka")
	},
	{
		name: "Vinted",
		url: vintedSearchUrl(b.pl || b.title)
	},
	{
		name: "Copernicus",
		url: "https://copcorp.pl/?s=" + encodeURIComponent(b.pl || b.title) + "&post_type=product"
	},
	{
		name: "Tantis · dział fantastyki",
		url: "https://tantis.pl/fantasy-science-fiction-horror-c5074"
	},
	{
		name: "Tantis · nowe",
		url: "https://tantis.pl/szukaj?query=" + encodeURIComponent(b.pl || b.title)
	},
	{
		name: "TaniaKsiazka · nowe",
		url: "https://www.taniaksiazka.pl/Search?q=" + encodeURIComponent(b.pl || b.title)
	},
	{
		name: "Blackwell’s · nowe EN",
		url: "https://blackwells.co.uk/bookshop/search/?keyword=" + encodeURIComponent(b.title)
	},
	{
		name: "Ceneo",
		url: "https://www.ceneo.pl/;szukaj-" + encodeURIComponent(b.pl || b.title)
	},
	{
		name: "Amazon PL",
		url: "https://www.amazon.pl/s?k=" + encodeURIComponent(b.pl || b.title) + "&i=stripbooks"
	},
	{
		name: "Empik · nowe",
		url: "https://www.empik.com/szukaj/produkt?q=" + encodeURIComponent(b.pl || b.title)
	},
	{
		name: "SkupSzop · wyszukiwarka",
		url: "https://www.google.com/search?q=" + encodeURIComponent("site:skupszop.pl " + (b.pl || b.title) + " książka")
	},
	{
		name: "ERLI · nowe",
		url: "https://erli.pl/kategoria?phrase=" + encodeURIComponent(b.pl || b.title)
	},
	...additionalStores.flatMap((shop) => [{
		name: shop.name + (shop.used ? " · antykwariat" : shop.mixed ? " · nowe i używane" : " · nowe"),
		url: shop.search ? additionalSearchUrl(b, shop) : shop.url
	}, ...(shop.extraUrls || []).map((url, i) => ({
		name: shop.name + " · dział " + (i + 2),
		url
	}))]),
	{
		name: "World of Books",
		url: "https://www.worldofbooks.com/en-gb/search?text=" + encodeURIComponent(b.title)
	},
	...sourceCandidates.filter((shop) => !shop.automatic).map((shop) => ({
		name: shop.name + " · " + shop.language,
		url: candidateSearchUrl(b, shop)
	}))
];
//#endregion
//#region lib/marketplaces.ts
function objectAt(text, start) {
	let depth = 0, inString = false, escaped = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === "\"") inString = false;
			continue;
		}
		if (c === "\"") inString = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) try {
			return JSON.parse(text.slice(start, i + 1));
		} catch {
			return null;
		}
	}
	return null;
}
function rscText(html) {
	const chunks = [];
	for (const m of html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)) try {
		const p = JSON.parse(m[1]);
		if (p[0] === 1 && typeof p[1] === "string") chunks.push(p[1]);
	} catch {}
	return chunks.join("");
}
function parseVinted(html, b, checked) {
	const out = [];
	const data = rscText(html);
	if (!/"productItem":\s*\{/.test(data) && !/"items":\s*\{\s*"items":\s*\[\s*\]/.test(data)) throw Error("Nie rozpoznano danych wyników Vinted; źródło nie zostało potwierdzone.");
	for (const m of data.matchAll(/"productItem":\s*\{/g)) {
		const p = objectAt(data, m.index + m[0].length - 1);
		if (!p || typeof p.title !== "string" || typeof p.url !== "string" || !/^\/items\/\d+/.test(p.url)) continue;
		const amount = p.priceWithDiscount?.amount ?? p.price?.amount;
		const currency = p.priceWithDiscount?.currencyCode ?? p.price?.currencyCode;
		if (typeof amount !== "string" && typeof amount !== "number") continue;
		const state = p.itemBox?.secondLine || "";
		const condition = /nowy|new with|new without/i.test(state) ? "new" : /dobry|zadowalaj|very good|good|satisfactory/i.test(state) ? "used" : "unknown";
		const o = baseOffer(b, p.title, "https://www.vinted.pl" + p.url, "Vinted", Number(amount), currency || "PLN", condition, checked, true);
		if (!o) continue;
		if (/magyar|hungarian|rész|français|francais|deutsch|german|italiano|espa[nñ]ol/i.test(p.title)) continue;
		const fee = p.serviceFee?.amount;
		const feeCurrency = p.serviceFee?.currencyCode;
		if (fee != null && feeCurrency === currency && Number.isFinite(Number(fee)) && Number(fee) >= 0) o.buyerFee = Number(fee);
		o.languageVerified = false;
		o.available = p.isSold !== true && p.isClosed !== true;
		out.push(o);
	}
	return Array.from(new Map(out.map((o) => [o.id, o])).values());
}
var domains = {
	pl: "www.amazon.pl",
	de: "www.amazon.de",
	uk: "www.amazon.co.uk"
};
function amazonUrl(b, market) {
	return "https://" + domains[market] + "/s?k=" + encodeURIComponent(market === "pl" ? b.pl || b.title : b.title) + "&i=stripbooks";
}
function moneyAmount(s, market) {
	const x = clean(s).replace(/&pound;/g, "£").replace(/&euro;/g, "€").replace(/(?:PLN|EUR|GBP|zł|€|£)/gi, "").replace(/\s/g, "");
	if (!(market === "uk" ? /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/ : /^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/).test(x)) return null;
	const n = market === "uk" ? Number(x.replace(/,/g, "")) : Number(x.replace(/\./g, "").replace(",", "."));
	return Number.isFinite(n) ? n : null;
}
function amazonCards(html) {
	const cards = [];
	for (const match of html.matchAll(/<div\b[^>]*data-component-type=["']s-search-result["'][^>]*>/g)) {
		const tags = /<\/?div\b[^>]*>/g;
		tags.lastIndex = match.index + match[0].length;
		let depth = 1, tag;
		while (tag = tags.exec(html)) {
			depth += tag[0].startsWith("</") ? -1 : 1;
			if (depth === 0) {
				cards.push(html.slice(match.index, tags.lastIndex));
				break;
			}
		}
	}
	return cards;
}
function parseAmazon(html, b, checked, market) {
	if (/Wir unterstützen deine Sitzung oder deinen Client nicht|session or client.{0,30}not supported|automated access|verify you are human|enter the characters you see below/i.test(clean(html))) throw Error("Amazon nie udostępnił wyników temu klientowi.");
	const cards = amazonCards(html);
	if (!cards.length && !/s-no-results|No results for|Keine Ergebnisse für|Brak wyników dla/i.test(html)) throw Error("Nie rozpoznano strony wyników Amazon.");
	const result = [];
	for (const part of cards) {
		const asin = part.match(/\bdata-asin=["']([A-Z0-9]{10})["']/)?.[1];
		const heading = part.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/)?.[1];
		if (!asin || !heading) continue;
		const title = clean(heading);
		const price = Array.from(part.matchAll(/<span\b[^>]*class=["']([^"']*\ba-price(?:\s[^"']*)?)["'][^>]*>[\s\S]*?<span\b[^>]*class=["'][^"']*\ba-offscreen\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/g)).find((p) => p[1].split(/\s+/).includes("a-price") && !p[1].split(/\s+/).includes("a-text-price"))?.[2];
		if (!price) continue;
		const amount = moneyAmount(price, market);
		if (amount === null) continue;
		const visible = clean(part);
		if (/Kindle|Audiobook|Audible|Hörbuch|e-book/i.test(visible)) continue;
		const currency = market === "pl" ? "PLN" : market === "de" ? "EUR" : "GBP";
		if (market === "pl" && !/zł|PLN/i.test(clean(price)) || market === "de" && !/€|EUR/i.test(clean(price)) || market === "uk" && !/£|GBP/i.test(clean(price))) continue;
		const condition = /(?:Stan|Condition|Zustand)\s*[:·-]?\s*(?:Używany|Used|Gebraucht)/i.test(visible) ? "used" : /(?:Stan|Condition|Zustand)\s*[:·-]?\s*(?:Nowy|New|Neu)/i.test(visible) ? "new" : "unknown";
		const o = baseOffer(b, title, "https://" + domains[market] + "/dp/" + asin, "Amazon " + market.toUpperCase(), amount, currency, condition, checked, true);
		if (o) {
			o.languageVerified = false;
			result.push(o);
		}
	}
	return Array.from(new Map(result.map((o) => [o.id, o])).values());
}
function amazonFailure(status, header = null, now = Date.now(), captcha = false) {
	const seconds = header?.trim() && /^\d+$/.test(header.trim()) ? Number(header) * 1e3 : NaN;
	const parsed = Number.isFinite(seconds) ? now + seconds : header ? Date.parse(header) : NaN;
	const until = Number.isFinite(parsed) ? Math.max(now + 3e4, parsed) : now + 3e4;
	return Object.assign(/* @__PURE__ */ new Error(captcha ? "Amazon wymaga weryfikacji dostępu." : `Amazon zwrócił błąd HTTP ${status}.`), {
		code: captcha ? "CAPTCHA" : "HTTP_" + status,
		retryAfter: new Date(until).toISOString()
	});
}
//#endregion
//#region lib/bookstores.ts
var bookstores = [
	{
		key: "empik",
		name: "Empik",
		origin: "https://www.empik.com"
	},
	{
		key: "erli",
		name: "ERLI",
		origin: "https://erli.pl"
	},
	{
		key: "tantis",
		name: "Tantis",
		origin: "https://tantis.pl"
	},
	{
		key: "tania",
		name: "TaniaKsiazka.pl",
		origin: "https://www.taniaksiazka.pl"
	},
	{
		key: "blackwells",
		name: "Blackwell’s",
		origin: "https://blackwells.co.uk"
	}
];
function bookstoreUrl(b, shop) {
	const q = encodeURIComponent(shop === "blackwells" ? b.title : b.pl || b.title);
	return shop === "empik" ? "https://www.empik.com/szukaj/produkt?q=" + q : shop === "erli" ? "https://erli.pl/kategoria?phrase=" + q : shop === "tantis" ? "https://tantis.pl/szukaj?query=" + q : shop === "tania" ? "https://www.taniaksiazka.pl/Search?q=" + q : "https://blackwells.co.uk/bookshop/search/?keyword=" + q;
}
function attr(tag, key) {
	return clean(tag.match(new RegExp("\\b" + key + "=[\"\\']([^\"\\']*)[\"\\']", "i"))?.[1] || "");
}
function safeUrl(raw, shop) {
	try {
		const origin = bookstores.find((s) => s.key === shop).origin;
		const u = new URL(raw, origin);
		if (u.origin !== origin || u.username || u.password) return null;
		if (!(shop === "empik" ? /,(?:p\d+|prod\d+),ksiazka-p$/.test(u.pathname) : shop === "erli" ? /^\/produkt\/[^/]+,\d+$/.test(u.pathname) : shop === "tantis" ? /-p\d+$/.test(u.pathname) : shop === "tania" ? /-p-\d+\.html$/.test(u.pathname) : /^\/bookshop\/product\//.test(u.pathname))) return null;
		const offer = u.searchParams.get("offerId");
		return u.origin + u.pathname + (shop === "empik" && offer && /^\d+$/.test(offer) ? "?offerId=" + offer : "");
	} catch {
		return null;
	}
}
function nodes(html) {
	const out = [];
	const visit = (x) => {
		if (!x || typeof x !== "object") return;
		if (Array.isArray(x)) {
			for (const n of x) visit(n);
			return;
		}
		out.push(x);
		for (const key of [
			"@graph",
			"itemListElement",
			"item"
		]) visit(x[key]);
	};
	for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) try {
		visit(JSON.parse(m[1]));
	} catch {}
	return out;
}
function discoverBookstoreUrls(html, b, shop) {
	const urls = /* @__PURE__ */ new Set();
	for (const n of nodes(html)) if (n.name && matches(b, n.name, true)) {
		const url = safeUrl(n.url || n["@id"] || "", shop);
		if (url) urls.add(url);
	}
	for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
		const tag = m[1];
		if (!matches(b, attr(tag, "data-name") || attr(tag, "title") || clean(m[2]), true)) continue;
		const url = safeUrl(attr(tag, "href"), shop);
		if (url) urls.add(url);
	}
	return [...urls];
}
function parseBookstore(html, b, checked, shop, pageUrl) {
	if (shop === "empik") return parseEmpik(html, b, checked, pageUrl);
	const source = bookstores.find((s) => s.key === shop).name;
	const out = [];
	for (const product of nodes(html)) {
		if (!(Array.isArray(product["@type"]) ? product["@type"] : [product["@type"]]).some((t) => ["Product", "Book"].includes(t)) || !product.name) continue;
		const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
		for (const data of offers) {
			if (!data || data.price == null || !data.priceCurrency) continue;
			const url = safeUrl(data.url || product.url || pageUrl, shop);
			if (!url) continue;
			const offer = baseOffer(b, product.name, url, source, Number(data.price), data.priceCurrency, shop === "erli" ? /NewCondition$/.test(data.itemCondition || product.itemCondition || "") ? "new" : /UsedCondition$/.test(data.itemCondition || product.itemCondition || "") ? "used" : "unknown" : "new", checked, true);
			if (!offer) continue;
			const author = typeof product.author === "string" ? product.author : Array.isArray(product.author) ? product.author.map((a) => a.name || "").join(", ") : product.author?.name;
			const publisher = typeof product.publisher === "string" ? product.publisher : product.publisher?.name;
			const match = classifyPaperBook(product.name, [b.title, b.pl || ""], {
				authors: bookAuthors(b),
				author,
				publisher,
				isbn: String(product.isbn || "")
			});
			if (match.state === "rejected") continue;
			Object.assign(offer, {
				matchStatus: match.state,
				matchReason: match.reason,
				author,
				publisher,
				isbn: product.isbn
			});
			if (offer.condition === "unknown") {
				offer.matchStatus = "review";
				offer.matchReason = "Stan egzemplarza nie jest potwierdzony. Sprawdź ofertę sprzedawcy.";
			}
			offer.available = /\/(InStock|LimitedAvailability)$/.test(data.availability || "");
			offer.availabilityKnown = /\/(InStock|LimitedAvailability|OutOfStock|SoldOut|Discontinued)$/.test(data.availability || "");
			out.push(offer);
		}
	}
	if (shop === "blackwells") for (const m of html.matchAll(/<button\b[^>]*data-product-name=["'][^>]*>/gi)) {
		const tag = m[0], title = attr(tag, "data-product-name"), format = attr(tag, "data-product-format");
		if (!/paperback|hardback|hardcover|board book/i.test(format)) continue;
		const isbn = attr(tag, "data-product-isbn");
		const links = discoverBookstoreUrls(html, b, shop);
		const direct = safeUrl(pageUrl, shop);
		const url = links.find((u) => u.endsWith("/" + isbn)) || (direct?.endsWith("/" + isbn) ? direct : null);
		if (!url) continue;
		const offer = baseOffer(b, title, url, source, Number(attr(tag, "data-product-price")), attr(tag, "data-currency"), "new", checked, true);
		if (!offer) continue;
		const publisher = attr(tag, "data-product-publisher");
		const match = classifyPaperBook(title, [b.title, b.pl || ""], {
			authors: bookAuthors(b),
			publisher,
			isbn
		});
		if (match.state === "rejected") continue;
		Object.assign(offer, {
			matchStatus: match.state,
			matchReason: match.reason,
			publisher,
			isbn
		});
		offer.available = !/\bdisabled\b/i.test(tag);
		out.push(offer);
	}
	const deduped = [...new Map(out.map((o) => [o.id, o])).values()];
	if (shop === "tantis") {
		const productUrl = safeUrl(pageUrl, shop);
		for (const offer of deduped) if (productUrl !== offer.url) {
			offer.available = false;
			offer.availabilityKnown = false;
		} else {
			const controls = [...html.matchAll(/<(?:button|span|div|p)\b[^>]*(?:class|id|data-testid)=["'][^"']*(?:availability|stock-status|product-stock|product-availability|add-to-cart|addToCart)[^"']*["'][^>]*>([\s\S]*?)<\/(?:button|span|div|p)>/gi)].map((m) => clean(m[1])).join(" ");
			if (/brak towaru|brak w magazynie|brak na stanie|produkt niedost[eę]pny|towar niedost[eę]pny|out of stock/i.test(controls)) {
				offer.available = false;
				offer.availabilityKnown = true;
			}
		}
	}
	return deduped;
}
var knownBookstorePages = {
	tantis: { "Horus Rising": ["https://tantis.pl/wywyzszenie-horusa-ziarna-herezji-zostaly-zasiane-herezja-horusa-wyd-2-p3551006"] },
	empik: { "Horus Rising": ["https://www.empik.com/wywyzszenie-horusa-herezja-horusa-tom-1-abnett-dan,prod480050,ksiazka-p"] },
	blackwells: { "Horus Rising": ["https://blackwells.co.uk/bookshop/product/Horus-Rising-by-Dan-Abnett/9781836093145"] }
};
async function bookstoreOffers(b, checked, shop, read) {
	const out = [];
	let searchFailed = false, failed = 0;
	let urls = [];
	let searchHTML = "";
	let lastError;
	let productWithoutPrice = false;
	let pagePartial = false;
	let coverage = "";
	try {
		const listing = await readSearchPages(bookstoreUrl(b, shop), read);
		pagePartial = listing.partial;
		coverage = listing.coverage;
		searchHTML = listing.pages.map((p) => p.html).join(" ");
		for (const page of listing.pages) {
			urls.push(...discoverBookstoreUrls(page.html, b, shop));
			out.push(...parseBookstore(page.html, b, checked, shop, page.url));
		}
	} catch (e) {
		searchFailed = true;
		lastError = e;
	}
	const discovered = [...new Set([...urls, ...knownBookstorePages[shop]?.[b.title] || []])];
	pagePartial ||= discovered.length > 9;
	urls = discovered.slice(0, 9);
	await runLimited(urls.map((url) => async () => {
		try {
			const page = await read(url);
			const offers = parseBookstore(page, b, checked, shop, url);
			if (shop === "tantis" && offers.some((o) => !o.availabilityKnown)) failed++;
			if (!offers.length) if (shop === "empik" && /window\.__APOLLO_STATE__/.test(page)) productWithoutPrice = true;
			else failed++;
			for (const offer of offers) {
				const earlier = out.find((o) => o.id === offer.id);
				if (!offer.seller && earlier?.seller) offer.seller = earlier.seller;
				out.push(offer);
			}
		} catch (e) {
			failed++;
			lastError = e;
		}
	}), 2);
	if (!out.length && String(lastError).includes("blocked")) throw Error("blocked");
	if (!out.length && !productWithoutPrice && (searchFailed || failed || !urls.length && !/nie znaleziono|brak wynik|no results|0 results/i.test(clean(searchHTML)) && !(shop === "tania" && /<h1\b[^>]*class=["'][^"']*listing__title[^"']*["'][^>]*>[\s\S]*?Wyniki wyszukiwania/i.test(searchHTML)))) throw Error("Nie udało się potwierdzić cen księgarni.");
	return {
		offers: [...new Map(out.map((o) => [o.id, o])).values()],
		partial: pagePartial || searchFailed || failed > 0,
		coverage: coverage + ` Sprawdzamy do 9 pasujących produktów.`
	};
}
function authorName(b, value) {
	const expected = bookAuthors(b);
	const tokens = (s) => s.toLowerCase().replace(/[^a-ząćęłńóśźż]+/g, " ").trim().split(/\s+/).sort().join(" ");
	return expected.find((a) => tokens(a) === tokens(value)) || value;
}
function empikEvidence(offer, b, author, publisher) {
	const match = classifyPaperBook(offer.title, [b.title, b.pl || ""], {
		authors: bookAuthors(b),
		author: authorName(b, author),
		publisher
	});
	if (match.state === "rejected") return false;
	Object.assign(offer, {
		author: authorName(b, author),
		publisher,
		matchStatus: match.state,
		matchReason: match.reason
	});
	if (offer.condition === "unknown") {
		offer.matchStatus = "review";
		offer.matchReason = "Oferta sprzedawcy zewnętrznego; stan egzemplarza do potwierdzenia.";
	}
	return true;
}
function parseEmpik(html, b, checked, pageUrl) {
	const out = [];
	const cards = [...html.matchAll(/<div\b[^>]*class=["'][^"']*search-list-item[^"']*["'][^>]*data-product-id=["'][^"']+["'][^>]*>/gi)];
	for (let i = 0; i < cards.length; i++) {
		const tag = cards[i][0], part = html.slice(cards[i].index, cards[i + 1]?.index ?? html.length);
		const title = attr(tag, "data-product-name");
		if (!/^Książki(?:\/|$)/i.test(attr(tag, "data-product-category"))) continue;
		const link = part.match(/href=["']([^"']+,ksiazka-p(?:\?[^"']*)?)["']/)?.[1];
		const url = link ? safeUrl(link, "empik") : null;
		const raw = attr(tag, "data-product-price");
		if (!url || !raw) continue;
		const seller = attr(tag, "data-merchant-name"), direct = attr(tag, "data-merchant-id") === "0";
		const offer = baseOffer(b, title, url, "Empik", Number(raw), "PLN", direct ? "new" : "unknown", checked, true);
		if (!offer) continue;
		if (!empikEvidence(offer, b, clean(part.match(/<a\b[^>]*class=["'][^"']*smartAuthor[ "'][^>]*>([\s\S]*?)<\/a>/i)?.[1] || ""), "")) continue;
		offer.seller = seller || void 0;
		const delivery = attr(tag, "data-delivery");
		offer.available = /wysyłka|wysylka|wysyłamy|wysylamy/i.test(delivery) && !/niedostępny|niedostepny/i.test(delivery);
		offer.availabilityKnown = offer.available || /niedostępny|niedostepny/i.test(delivery);
		out.push(offer);
	}
	const raw = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/)?.[1];
	if (raw) try {
		const state = JSON.parse(raw), resolve = (v) => v?.__ref ? state[v.__ref] : v;
		for (const [key, value] of Object.entries(state)) {
			if (!key.startsWith("Product:")) continue;
			const product = value, info = product.baseInformation, price = resolve(product.bestOffer);
			if (info?.type !== "PHYSICAL" || !info.categoryInfo?.categories?.some((c) => c.name === "Książki") || !price || price.appliedDiscount != null) continue;
			const direct = /:0$/.test(price.offerId || "");
			const selectedId = String(price.offerId || "").split(":").at(-1);
			const base = safeUrl(pageUrl, "empik");
			if (!base || !selectedId || !/^\d+$/.test(selectedId)) continue;
			const target = new URL(base);
			target.search = "";
			if (!direct) target.searchParams.set("offerId", selectedId);
			const url = target.href;
			const amount = Number(price.originalPrice);
			const offer = baseOffer(b, info.name || "", url, "Empik", amount, "PLN", direct ? "new" : "unknown", checked, true);
			if (!offer) continue;
			if (!empikEvidence(offer, b, (info.creatorAttributes?.author || []).join(", "), (info.creatorAttributes?.publisher || []).join(", "))) continue;
			const availability = price.availability?.type || "";
			offer.available = /^IN_|^AVAILABLE$/.test(availability);
			offer.availabilityKnown = offer.available || availability === "UNAVAILABLE";
			offer.seller = direct ? "Empik" : void 0;
			offer.image = info.cover?.small || null;
			out.push(offer);
		}
	} catch {}
	return [...new Map(out.map((o) => [o.id, o])).values()];
}
//#endregion
//#region lib/scanner.ts
var clean = (s) => s.replace(/<[^>]*>/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
function matches(book, title, contextual = false) {
	const result = classifyPaperBook(clean(title), [book.pl || "", book.title], { authors: bookAuthors(book) });
	return contextual ? result.state !== "rejected" : result.state === "matched";
}
function isBundle(b, title) {
	if (/zestaw|pakiet|bundle|collection of|set of|books?\s*\d+\s*[-–]\s*\d+|\d+\s*ksi[aą][żz]ek|\d+\s*books/i.test(title)) return true;
	if (b.kind === "powieść" && /omnibus|trilogy|trylogia/i.test(title)) return true;
	const t = " " + norm(title) + " ";
	return catalog.filter((other) => other.series === b.series && other.number !== null && [other.title, other.pl].filter(Boolean).some((n) => norm(n).length >= 8 && t.includes(" " + norm(n) + " "))).length > 1;
}
function baseOffer(b, title, url, source, price, currency, condition, checked, contextual = false) {
	if (!Number.isFinite(price) || price <= 0 || price > 1e5 || classifyPaperBook(clean(title), [b.pl || "", b.title], { authors: bookAuthors(b) }).state === "rejected" || !url.startsWith("https://")) return null;
	const language = b.pl && (" " + norm(title) + " ").includes(" " + norm(b.pl) + " ") ? "PL" : (" " + norm(title) + " ").includes(" " + norm(b.title) + " ") ? "EN" : "?";
	return {
		id: source + ":" + url,
		bookId: b.id,
		title: clean(title),
		url,
		source,
		price,
		currency,
		condition,
		language,
		shipping: null,
		pln: currency === "PLN" ? price : null,
		available: true,
		checked,
		origin: "live",
		languageVerified: false,
		bundle: isBundle(b, title),
		match: "candidate",
		matchStatus: classifyPaperBook(clean(title), [b.pl || "", b.title], { authors: bookAuthors(b) }).state,
		matchReason: classifyPaperBook(clean(title), [b.pl || "", b.title], { authors: bookAuthors(b) }).reason
	};
}
function parseOlx(html, b, checked) {
	const out = [];
	for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) try {
		const node = JSON.parse(m[1]);
		for (const o of node.offers?.offers || []) {
			const r = baseOffer(b, o.name || "", o.url || "", "OLX", +o.price, o.priceCurrency || "PLN", /UsedCondition/.test(o.itemCondition) ? "used" : /NewCondition/.test(o.itemCondition) ? "new" : "unknown", checked);
			if (r) out.push(r);
		}
	} catch {}
	return out;
}
function parseWoo(rows, b, checked) {
	return rows.flatMap((p) => {
		const r = baseOffer(b, p.name || "", p.permalink || "", "Copernicus", +p.prices?.price / 10 ** (p.prices?.currency_minor_unit ?? 2), p.prices?.currency_code || "PLN", "new", checked, true);
		if (!r) return [];
		r.matchStatus = "matched";
		r.matchReason = "Tytuł w katalogu wydawcy Copernicus.";
		const stock = p.stock_availability || {};
		const explicitOut = p.is_in_stock === false || /out-of-stock|outofstock/i.test(stock.class || "") || /brak w magazynie|brak towaru|brak na stanie|niedost[eę]pn|out of stock/i.test(clean(stock.text || ""));
		r.available = p.is_in_stock === true && p.is_purchasable === true && p.is_on_backorder !== true && !explicitOut;
		r.availabilityKnown = explicitOut || typeof p.is_in_stock === "boolean" && (p.is_purchasable === false || p.is_on_backorder === true) || r.available;
		r.match = norm(clean(p.name)) === norm(b.pl || b.title) ? "exact" : "candidate";
		return [r];
	});
}
function parseEbay(html, b, checked) {
	const out = [];
	for (const part of html.split(/<li\b/).slice(1)) {
		if (!/class=["']?s-card|s-item/.test(part.slice(0, 250))) continue;
		const title = part.match(/class=["']?s-card__title["']?[^>]*>([\s\S]*?)<\/div>/)?.[1] || part.match(/class=["'][^"']*s-item__title[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/)?.[1];
		const pm = part.match(/class=["'][^"']*(?:s-card__price|s-item__price)[^"']*["'][^>]*>([\s\S]*?)<\/span>/);
		const link = part.match(/href=["']?(https:\/\/(?:www\.)?ebay\.[^\s"'>]+\/itm\/[^\s"'>]+)/)?.[1];
		if (!title || !pm || !link) continue;
		const amount = clean(pm[1]);
		if (/ to |–/.test(amount)) continue;
		const currency = amount.includes("£") ? "GBP" : amount.includes("EUR") || amount.includes("€") ? "EUR" : /\$|USD/.test(amount) ? "USD" : null;
		const price = Number(amount.replace(/[^\d.,]/g, "").replace(/,/g, ""));
		if (!currency || /\d+ bids?\b/i.test(clean(part))) continue;
		const condition = /Pre-owned|Used|Very Good|Good|Acceptable/i.test(clean(part)) ? "used" : /Brand New|New other/i.test(clean(part)) ? "new" : "unknown";
		const r = baseOffer(b, clean(title), clean(link).split("?")[0], "eBay", price, currency, condition, checked);
		if (r) out.push(r);
	}
	return out;
}
function scanErrorDetail(error) {
	const e = error;
	return clean([
		e?.name,
		e?.message || String(error),
		e?.code,
		e?.cause?.code
	].filter(Boolean).join(": ")).replace(/https?:\/\/[^\s]+/g, "[adres źródła]").slice(0, 240);
}
var sourceReaderHosts = {
	vinted: "vinted.pl",
	lagano: "lagano.pl",
	poznan: "antykwariat.pl",
	nws: "antykwariatnws.pl",
	kwadryga: "kwadryga.com",
	adumaru: "adumaru.pl",
	battlecult: "battlecult.pl",
	graal: "sklep-graal.pl",
	kulturawraca: "kulturawraca.pl",
	megaksiazki: "megaksiazki.pl",
	mepel: "mepel.pl",
	osnowa: "osnowa.pl",
	zagrajnik: "zagrajnik.shop",
	panmysza: "panmysza.pl",
	hegemon: "hegemonshop.com",
	lokalnie: "allegrolokalnie.pl"
};
function readerFailure(status, requestId, retryHeader) {
	const code = status === void 0 ? "READER_CONNECTION" : status === 200 ? "READER_UNVERIFIED_PAGE" : `READER_HTTP_${status}`;
	return Object.assign(/* @__PURE__ */ new Error((status === 200 ? "Pośrednik Vercel zwrócił stronę weryfikacji bez potwierdzonej odpowiedzi źródła." : status === 401 || status === 403 ? "Pośrednik Vercel odmówił dostępu. Sprawdź autoryzację i ochronę wdrożenia." : status === 429 ? "Pośrednik Vercel ogranicza zapytania lub jest przeciążony." : status === void 0 ? "Nie udało się połączyć z pośrednikiem Vercel." : "Pośrednik Vercel nie wykonał odczytu.") + (status === void 0 ? "" : ` HTTP ${status}.`) + " Nie potwierdzono odpowiedzi źródła; to nie jest potwierdzona blokada serwisu."), {
		code,
		errorOrigin: "reader",
		...status === void 0 ? {} : { httpStatus: status },
		...requestId ? { requestId } : {},
		retryAfter: vintedFailure(status ?? 502, retryHeader).retryAfter
	});
}
function readerTraceMessage(attempts) {
	const recent = attempts.slice(-2);
	if (!recent.some((a) => a.httpStatus && a.httpStatus >= 400 || a.errorCode)) return "";
	const labels = recent.map((a) => (a.reader === "primary" ? "Vercel 1" : "Vercel 2") + " (" + a.host + "): " + (a.httpStatus ? "HTTP " + a.httpStatus : "błąd połączenia"));
	const both = recent.length === 2 && recent[0].reader !== recent[1].reader && recent.every((a) => a.httpStatus === 403 || a.httpStatus === 429);
	return " Próby serwerów: " + labels.join(" → ") + "." + (both ? " Przełączenie wykonane; oba serwery zakończyły odczyt odmową." : "");
}
async function sourceReaderResponse(url, token, signal, endpoint, backup, primaryProtectionToken) {
	if (!token || token.length < 32) return null;
	const target = new URL(url), source = Object.entries(sourceReaderHosts).find(([, host]) => target.hostname === host || target.hostname === "www." + host)?.[0];
	if (!source) return null;
	if (target.protocol !== "https:" || target.username || target.password || target.port) throw Error("Nieprawidłowy adres źródła.");
	const validate = (value) => {
		const u = new URL(value);
		if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash || u.search) throw Error("Nieprawidłowa konfiguracja serwera odczytu.");
		return u.href;
	};
	const primary = {
		endpoint: validate(endpoint || (source === "vinted" ? "https://nextjs-boilerplate-lb8m.vercel.app/api/source-page" : "https://nextjs-boilerplate-lb8m.vercel.app/api/source-page-fantasy")),
		token,
		reader: "primary",
		protectionToken: primaryProtectionToken
	};
	const secondary = backup && backup.token.length >= 32 ? {
		endpoint: validate(backup.endpoint),
		token: backup.token,
		reader: "backup",
		protectionToken: backup.protectionToken
	} : void 0;
	const choices = secondary && secondary.endpoint !== primary.endpoint ? backup?.preferBackup?.(source) ? [secondary, primary] : [primary, secondary] : [primary];
	let after;
	for (let index = 0; index < choices.length; index++) {
		signal?.throwIfAborted();
		const choice = choices[index];
		backup?.onAttempt?.(choice.reader, after);
		let response;
		try {
			response = await fetch(choice.endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer " + choice.token,
					...choice.protectionToken ? { "x-vercel-protection-bypass": choice.protectionToken } : {}
				},
				body: JSON.stringify({
					source,
					url
				}),
				signal,
				redirect: "manual",
				cache: "no-store"
			});
		} catch (error) {
			signal?.throwIfAborted();
			backup?.onResult?.({
				reader: choice.reader,
				host: new URL(choice.endpoint).hostname,
				errorOrigin: "reader",
				errorCode: "READER_CONNECTION"
			});
			throw Object.assign(readerFailure(void 0), { reader: choice.reader });
		}
		const upstream = response.headers.get("x-source-upstream-status");
		const verified = upstream === String(response.status) && /^[45]\d\d$/.test(upstream);
		backup?.onResult?.({
			reader: choice.reader,
			host: new URL(choice.endpoint).hostname,
			httpStatus: response.status,
			errorOrigin: verified || response.headers.has("x-source-fetched-at") ? "source" : "reader",
			requestId: response.headers.get("x-vercel-id")?.replace(/[^a-zA-Z0-9:_.-]/g, "").slice(0, 120)
		});
		if (index === 0 && choices.length === 2 && ([403, 429].includes(response.status) || response.status === 401 && !verified)) {
			const next = choices[1];
			await backup?.onSwitch?.(source, next.reader === "backup", response.status);
			if (verified && response.status === 429) {
				backup?.onAttempt?.(choice.reader, 429, true);
				return response;
			}
			after = response.status;
			await response.body?.cancel();
			continue;
		}
		const requestId = response.headers.get("x-vercel-id")?.replace(/[^a-zA-Z0-9:_.-]/g, "").slice(0, 120);
		if (!response.ok && !verified) {
			await response.body?.cancel();
			throw Object.assign(readerFailure(response.status, requestId, response.headers.get("retry-after")), {
				reader: choice.reader,
				failoverAfter: after
			});
		}
		return response;
	}
	throw readerFailure(void 0);
}
async function fetchLimited(url, parent, readerToken, readerEndpoint, readerBackup, readerProtectionToken) {
	parent?.throwIfAborted();
	const timeout = new URL(url).hostname === "www.vinted.pl" ? 23e3 : 18e3;
	const relayed = await sourceReaderResponse(url, readerToken, parent, readerEndpoint, readerBackup, readerProtectionToken);
	const response = relayed || await fetchPublicAntiquarianPage(url, {
		headers: {
			Accept: "text/html",
			"User-Agent": "ArchiwumFantasy/1.0 (book price comparison)"
		},
		signal: parent ? AbortSignal.any([parent, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
	});
	if (!response.ok && new URL(url).hostname.endsWith("vinted.pl")) throw Object.assign(vintedFailure(response.status, response.headers.get("Retry-After")), { requestId: relayed?.headers.get("x-vercel-id")?.replace(/[^a-zA-Z0-9:_.-]/g, "").slice(0, 120) });
	if (!response.ok && /^www\.amazon\.(?:pl|de|co\.uk)$/.test(new URL(url).hostname)) throw amazonFailure(response.status, response.headers.get("Retry-After"));
	if (!response.ok && !isHermesEmptyCandidate(url, response.status)) throw Object.assign(/* @__PURE__ */ new Error(response.status === 403 || response.status === 429 ? "blocked HTTP " + response.status : "HTTP " + response.status), {
		errorOrigin: "source",
		httpStatus: response.status,
		code: "HTTP_" + response.status
	});
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > 65e5) {
			await reader.cancel();
			throw new Error("Strona jest zbyt duża do bezpiecznego odczytu.");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const x of chunks) {
		bytes.set(x, offset);
		offset += x.length;
	}
	const declared = response.headers.get("content-type")?.match(/charset=([^; ]+)/i)?.[1] || new TextDecoder().decode(bytes.slice(0, 4e3)).match(/charset=["']?([a-z0-9-]+)/i)?.[1] || "utf-8";
	let text;
	try {
		text = new TextDecoder(declared).decode(bytes);
	} catch {
		text = new TextDecoder().decode(bytes);
	}
	if (/captcha|verify you are human|Access Denied|Just a moment\.\.\.|cf-chl-|Przekroczono limit wyszukiwań/i.test(text) && text.length < 1e5) {
		if (relayed && !response.headers.has("x-source-fetched-at")) throw readerFailure(response.status);
		if (new URL(url).hostname.endsWith("vinted.pl")) throw vintedFailure(200, null, Date.now(), true);
		if (/^www\.amazon\.(?:pl|de|co\.uk)$/.test(new URL(url).hostname)) throw amazonFailure(200, null, Date.now(), true);
		throw new Error("blocked");
	}
	if (isHermesEmptyCandidate(url, response.status) && !isHermesEmptyPage(text)) throw Object.assign(/* @__PURE__ */ new Error("HTTP 404"), {
		httpStatus: 404,
		code: "HTTP_404",
		errorOrigin: "source"
	});
	return normalizePublicAntiquarianSearch(text, url);
}
async function readWithConnectionRetry(read, signal, enabled) {
	try {
		return await read();
	} catch (error) {
		signal.throwIfAborted();
		const e = error;
		if (!enabled || e.retryAfter || e.code || !/network|connection|fetch failed|failed to fetch|load failed|socket|terminated/i.test(e.message)) throw error;
		await waitVinted(1500, signal);
		signal.throwIfAborted();
		return read();
	}
}
var SCANNER_VERSION = 47;
var sourcePriority = {
	"Vinted": 10,
	"Booksale": 3,
	"Megaksiążki": 2,
	"Hegemon Shop": 1,
	"Pan Mysza": 1,
	"Allegro Lokalnie": 1
};
async function runLimited(jobs, limit = 3, canStart = () => true) {
	const output = new Array(jobs.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
		while (next < jobs.length && canStart()) {
			const i = next++;
			output[i] = await jobs[i]();
		}
	}));
	return output.filter(() => true);
}
async function vintedOffers(b, checked, read, budget = 9e4) {
	const queue = Array.from(new Set([b.pl, b.title].filter(Boolean))).map((term) => ({
		term,
		url: vintedSearchUrl(term),
		pages: 0,
		seen: /* @__PURE__ */ new Set(),
		contents: /* @__PURE__ */ new Set()
	}));
	const offers = [];
	let partial = false, successes = 0;
	let error;
	const until = Date.now() + Math.max(1, budget - Math.min(2e3, budget * .15));
	while (queue.some((q) => q.url && q.pages < 10)) {
		for (const q of queue) {
			if (!q.url || q.pages >= 10) continue;
			const remaining = until - Date.now();
			if (remaining <= 0) {
				partial = true;
				break;
			}
			try {
				if (q.seen.has(q.url)) throw Error("Powtórzony adres strony wyników.");
				q.seen.add(q.url);
				const html = await withDeadline((signal) => read(q.url, signal), Math.min(25e3, remaining), "Przekroczono czas strony Vinted.");
				if (q.contents.has(html)) throw Error("Powtórzona treść strony wyników.");
				q.contents.add(html);
				offers.push(...parseVinted(html, b, checked));
				successes++;
				q.pages++;
				q.url = nextSearchPage(html, q.url) || "";
				if (q.url && q.pages === 10) partial = true;
			} catch (e) {
				partial = true;
				error = e;
				q.url = "";
				if (error.retryAfter) break;
			}
		}
		if (error?.retryAfter || Date.now() >= until) break;
	}
	if (queue.some((q) => q.url)) partial = true;
	if (!successes) throw error || /* @__PURE__ */ new Error("Nie odczytano wyników Vinted.");
	return {
		offers: Array.from(new Map(offers.map((o) => [o.url.match(/\/items\/(\d+)/)?.[1] || o.id, o])).values()),
		partial,
		...error?.retryAfter ? { retryAfter: error.retryAfter } : {},
		...error ? { failure: {
			errorOrigin: error.errorOrigin,
			errorCode: error.code,
			httpStatus: error.httpStatus,
			requestId: error.requestId
		} } : {},
		coverage: "Vinted: kategoria Książki; tytuły PL/EN sprawdzane naprzemiennie. " + queue.map((q) => `„${q.term}”: ${q.pages} stron (limit 10).`).join(" ") + (partial ? " Odczyt niepełny — zachowano znalezione oferty." : "") + (error ? " " + error.message : "") + " Brak dopasowań nie potwierdza braku książki w całym serwisie."
	};
}
async function marketplacePages(url, read, parse) {
	const result = await readSearchPages(url, read);
	const offers = [];
	let partial = result.partial;
	for (const page of result.pages) try {
		offers.push(...parse(page.html));
	} catch (e) {
		if (result.pages.length === 1) throw e;
		partial = true;
	}
	return {
		offers: [...new Map(offers.map((o) => [o.id, o])).values()],
		partial,
		...result.error ? { retryAfter: result.error.retryAfter || new Date(Date.now() + 3e4).toISOString() } : {},
		coverage: result.coverage
	};
}
async function wooPages(b, checked, read) {
	if (!b.pl) return {
		offers: [],
		coverage: "Katalog wydawcy jest przeszukiwany po tytule polskim."
	};
	const offers = [];
	let partial = false, pages = 0;
	for (let page = 1; page <= 3; page++) try {
		const rows = JSON.parse(await read("https://copcorp.pl/wp-json/wc/store/v1/products?search=" + encodeURIComponent(b.pl) + "&per_page=30&page=" + page));
		if (!Array.isArray(rows)) throw Error("Nieprawidłowy katalog wydawcy.");
		pages++;
		offers.push(...parseWoo(rows, b, checked));
		if (rows.length < 30) break;
		if (page === 3) partial = true;
	} catch (e) {
		if (page === 1) throw e;
		partial = true;
		break;
	}
	return {
		offers: [...new Map(offers.map((o) => [o.id, o])).values()],
		partial,
		coverage: `Katalog wydawcy: ${pages} stron po maksymalnie 30 produktów (limit 3 stron).`
	};
}
async function scanBook(b, cooldowns = {}, scope = "all", selectedSources, budgets = {
	source: 35e3,
	book: 12e4,
	vinted: 9e4
}, parent, vintedPolicy, marketplacePolicies, readerToken, readerEndpoint, readerBackup, readerProtectionToken) {
	const launchUntil = budgets.launchWindow === void 0 ? Infinity : Date.now() + budgets.launchWindow;
	const bookSignal = parent ? AbortSignal.any([parent, AbortSignal.timeout(budgets.book)]) : AbortSignal.timeout(budgets.book);
	const checked = (/* @__PURE__ */ new Date()).toISOString();
	const links = searchLinks(b);
	const results = await runLimited([
		{
			source: "Allegro Lokalnie",
			url: "https://allegrolokalnie.pl/oferty/q/" + encodeURIComponent(b.pl || b.title),
			run: (read) => allegroOffers(b, checked, read)
		},
		{
			source: "Copernicus",
			url: links.find((l) => l.name === "Copernicus").url,
			run: async (read) => wooPages(b, checked, read)
		},
		{
			source: "SkupSzop",
			url: links.find((l) => l.name.startsWith("SkupSzop")).url,
			run: async (read) => ({
				offers: [],
				manual: true
			})
		},
		...additionalStores.map((shop) => ({
			source: shop.name,
			url: additionalSearchUrl(b, shop),
			run: (read) => additionalStoreOffers(b, checked, shop, read)
		})),
		...bookstores.map((shop) => ({
			source: shop.name,
			url: bookstoreUrl(b, shop.key),
			run: (read) => bookstoreOffers(b, checked, shop.key, read)
		})),
		{
			source: "Vinted",
			url: links.find((l) => l.name === "Vinted").url,
			run: (read) => vintedOffers(b, checked, read, budgets.vinted ?? budgets.source)
		},
		...["pl"].map((m) => ({
			source: "Amazon " + m.toUpperCase(),
			url: amazonUrl(b, m),
			run: async (read) => marketplacePages(amazonUrl(b, m), read, (html) => parseAmazon(html, b, checked, m))
		}))
	].filter((j) => !isManualScanSource(j.source)).filter((j) => !selectedSources || selectedSources.includes(j.source)).filter((j) => scope === "all" || ["SkupSzop", "Tezeusz"].includes(j.source) || (scope === "used" ? [
		"OLX",
		"eBay",
		"Vinted",
		"Allegro Lokalnie"
	].includes(j.source) || isAntiquarianSource(j.source) : ![
		"OLX",
		"eBay",
		"Vinted",
		"Allegro Lokalnie"
	].includes(j.source) && !isAntiquarianSource(j.source))).sort((a, b) => (sourcePriority[b.source] || 0) - (sourcePriority[a.source] || 0)).map((j) => async () => {
		const started = performance.now();
		let requestCount = 0;
		const readerAttempts = [];
		let readerUsed, switchedAfter, deferredSwitch = false;
		const sourceReaderBackup = readerBackup ? {
			...readerBackup,
			onResult: (attempt) => {
				readerAttempts.push(attempt);
				if (readerAttempts.length > 10) readerAttempts.shift();
			},
			onAttempt: (reader, after, deferred) => {
				readerUsed = reader;
				if (after !== void 0) {
					switchedAfter = after;
					deferredSwitch = !!deferred;
					if (!deferred) requestCount++;
				}
			}
		} : void 0;
		const result = await (async () => {
			try {
				bookSignal.throwIfAborted();
				const retryAfter = cooldowns[j.source];
				if (retryAfter && Date.parse(retryAfter) > Date.now()) return {
					offers: [],
					status: {
						source: j.source,
						url: j.url,
						state: "skipped",
						retryAfter,
						message: "Przerwa po nieudanym odczycie. Następna próba po " + new Date(retryAfter).toLocaleTimeString("pl-PL", {
							timeZone: "Europe/Warsaw",
							hour: "2-digit",
							minute: "2-digit"
						}) + ". Pozostałe źródła są sprawdzane."
					}
				};
				const sourceBudget = j.source === "Vinted" ? budgets.vinted ?? budgets.source : budgets.source;
				const sourceUntil = Date.now() + Math.max(1, sourceBudget - Math.min(1500, sourceBudget * .1));
				const response = await withDeadline((signal) => j.run(async (url, child) => {
					const remaining = sourceUntil - Date.now();
					if (remaining <= 0) throw new DOMException("Wyczerpano czas odczytu źródła.", "TimeoutError");
					return withDeadline(async (inner) => {
						const combined = AbortSignal.any([
							signal,
							inner,
							...child ? [child] : []
						]);
						const policy = j.source === "Vinted" ? vintedPolicy : marketplacePolicies?.[j.source];
						await policy?.beforeRead(combined);
						try {
							return await readWithConnectionRetry(async () => {
								requestCount++;
								return await fetchLimited(url, combined, readerToken, readerEndpoint, sourceReaderBackup, readerProtectionToken);
							}, combined, j.source === "Vinted");
						} catch (e) {
							if (policy && e.errorOrigin !== "reader") {
								const failure = e;
								if (!failure.retryAfter && failure.name !== "AbortError") Object.assign(failure, { retryAfter: new Date(Date.now() + 3e4).toISOString() });
								await policy.onFailure(failure);
							}
							throw e;
						}
					}, Math.min(j.source === "Vinted" ? 25e3 : 18e3, remaining), "Przekroczono czas odczytu strony źródła.");
				}), sourceBudget, "Przekroczono czas odczytu źródła.", bookSignal);
				if (j.source.startsWith("Amazon") && response.retryAfter) await marketplacePolicies?.[j.source]?.onFailure(Object.assign(/* @__PURE__ */ new Error("Nie udało się odczytać kolejnej strony Amazon."), { retryAfter: response.retryAfter }));
				const offers = response.offers;
				const manual = "manual" in response && response.manual;
				const partial = "partial" in response && response.partial;
				return {
					offers,
					status: {
						source: j.source,
						url: j.url,
						...response.failure || {},
						...response.retryAfter ? { retryAfter: response.retryAfter } : {},
						state: manual ? "manual" : partial ? "partial" : offers.length ? "ok" : "empty",
						message: manual ? "coverage" in response ? String(response.coverage) : "SkupSzop: odczyt produktów zablokowany podczas sprawdzania. Wyszukaj tytuł i dodaj ofertę ręcznie. „Jak nowa” oznacza używaną książkę." : (offers.length ? `${offers.length} dopasowań; ${offers.filter((o) => o.available).length} oznaczonych jako dostępne` : "Brak dopasowanych ofert na odczytanej stronie.") + (partial ? " Odczyt częściowy — szczegóły zakresu poniżej." : "") + ("coverage" in response ? " " + response.coverage : "")
					}
				};
			} catch (e) {
				if (parent?.aborted) throw parent.reason || e;
				const message = String(e);
				const timedOut = bookSignal.aborted || e.name === "TimeoutError";
				const vintedError = e;
				const failureInfo = {
					...vintedError.errorOrigin ? { errorOrigin: vintedError.errorOrigin } : {},
					...vintedError.code ? { errorCode: vintedError.code } : {},
					...vintedError.httpStatus !== void 0 ? { httpStatus: vintedError.httpStatus } : {},
					...vintedError.requestId ? { requestId: vintedError.requestId } : {}
				};
				const vintedRetry = j.source === "Vinted" ? vintedError.retryAfter : void 0;
				const blocked = message.includes("blocked") || (j.source === "Vinted" || j.source.startsWith("Amazon")) && [
					"HTTP_403",
					"HTTP_429",
					"CAPTCHA",
					"COOLDOWN"
				].includes(vintedError.code || "");
				const amazonRetry = j.source.startsWith("Amazon") ? vintedError.retryAfter || new Date(Date.now() + 3e4).toISOString() : void 0;
				if (amazonRetry) await marketplacePolicies?.[j.source]?.onFailure(Object.assign(new Error(message), { retryAfter: amazonRetry }));
				return {
					offers: [],
					status: {
						source: j.source,
						url: j.url,
						state: blocked ? "blocked" : "error",
						...failureInfo,
						...vintedRetry ? { retryAfter: vintedRetry } : {},
						...amazonRetry ? { retryAfter: amazonRetry } : {},
						message: vintedError.errorOrigin === "reader" ? vintedError.message + " Przerwa po błędzie pośrednika; poprzednie oferty zachowują datę ostatniego odczytu." : amazonRetry ? message + " Odczyt czasowo wstrzymany. Kolejna próba po: " + new Date(amazonRetry).toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw" }) + ". Poprzednie ceny pozostają z datą ostatniego odczytu; błąd nie oznacza braku ofert." : vintedRetry ? message + " Odczyt wstrzymany do wskazanego czasu. To nie oznacza braku ofert." : timedOut ? "Przekroczono czas odczytu. Źródło nie zostało w pełni sprawdzone; to nie oznacza braku ofert." : blocked ? "Serwis blokuje automatyczny odczyt. Otwórz wyszukiwanie." : "Nie udało się odczytać źródła. Przyczyna: " + scanErrorDetail(e) + ". Błąd nie oznacza braku ofert."
					}
				};
			}
		})();
		return {
			...result,
			status: {
				...result.status,
				...readerAttempts.length ? { readerAttempts } : {},
				...readerUsed ? { reader: readerUsed } : {},
				...switchedAfter !== void 0 ? { failoverAfter: switchedAfter } : {},
				message: result.status.message + readerTraceMessage(readerAttempts) + (readerUsed ? " Serwer odczytu: " + (readerUsed === "backup" ? "drugi Vercel" : "pierwszy Vercel") + "." : "") + (switchedAfter !== void 0 ? deferredSwitch ? " Następna próba przejdzie na " + (readerUsed === "backup" ? "pierwszy" : "drugi") + " serwer po zakończeniu przerwy HTTP 429." : " Przełączono serwer po HTTP " + switchedAfter + "." : ""),
				durationMs: Math.round(performance.now() - started),
				requestCount
			}
		};
	}), Math.max(1, Math.min(8, budgets.concurrency || 3)), () => Date.now() < launchUntil);
	const offers = Array.from(new Map(results.flatMap((r) => r.offers).map((o) => [o.id, o])).values());
	if (offers.some((o) => o.currency !== "PLN")) try {
		const tables = JSON.parse(await withDeadline((signal) => fetchLimited("https://api.nbp.pl/api/exchangerates/tables/a/?format=json", signal), 18e3, "Przekroczono czas odczytu kursów.", bookSignal));
		for (const o of offers) {
			const rate = tables[0].rates.find((r) => r.code === o.currency);
			if (rate) {
				o.pln = Math.round(o.price * rate.mid * 100) / 100;
				if (o.buyerFee != null) o.buyerFeePln = Math.round(o.buyerFee * rate.mid * 100) / 100;
				o.fxDate = tables[0].effectiveDate;
			}
		}
	} catch {}
	parent?.throwIfAborted();
	for (const o of offers) if (o.currency === "PLN" && o.buyerFee != null) o.buyerFeePln = o.buyerFee;
	return {
		id: b.id,
		checked,
		scannerVersion: 47,
		scope,
		selectedSources,
		offers,
		sources: results.map((r) => r.status)
	};
}
//#endregion
export { SCANNER_VERSION, baseOffer, clean, fetchLimited, isBundle, matches, parseEbay, parseOlx, parseWoo, readWithConnectionRetry, readerFailure, readerTraceMessage, runLimited, scanBook, scanErrorDetail, sourceReaderHosts, sourceReaderResponse, vintedOffers };
