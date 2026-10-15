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
//#region lib/source-access.ts
var manualSourceDetails = {
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
var attr$1 = (tag, name) => decode(tag.match(new RegExp("\\b" + name + "=[\"\\']([^\"\\']*)[\"\\']", "i"))?.[1] || "");
function safeNext(raw, current) {
	try {
		const base = new URL(current), u = new URL(decode(raw), base);
		if (u.origin !== base.origin || u.username || u.password || u.protocol !== "https:" || u.href === base.href) return null;
		for (const key of [
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
			attr$1(tag, "rel"),
			attr$1(tag, "aria-label"),
			attr$1(tag, "title"),
			attr$1(tag, "class")
		].join(" ");
		if (/\bnext\b|nast[eę]pna(?: strona)?|pagination__next|pagination-next/i.test(label)) {
			const url = safeNext(attr$1(tag, "href"), current);
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
var isAntiquarianSource = (name) => antiquarianSources.some((s) => s.name === name.split(" · ")[0]);
var antiquarianSearch = (url) => "https://www.google.com/search?q=" + encodeURIComponent("site:" + new URL(url).hostname + " ") + "{q}%20Warhammer%20ksi%C4%85%C5%BCka";
//#endregion
//#region lib/book-matching.ts
var normalizeBookText = (s) => s.replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, decimal) => String.fromCodePoint(Math.min(parseInt(hex || decimal, hex ? 16 : 10), 1114111))).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").replace(/[^a-z0-9]+/g, " ").trim();
var unrelated = /\b(mtg|cd|dvd|vinyl|lp|ep|lego|stl)\b|blu[ -]?ray|magic:? the gathering|pok[eé]mon|yu-?gi-?oh|karta kolekcjonerska|rodzaj:? single|figurki?|miniatures?|joytoy|ebook|e-book|audiobook|kindle|gra planszowa|gra karciana|board game|płyta|płyty|plyta|plyty|winyl|soundtrack|album muzyczny|music album|bookmark|poster|artwork|dust jacket only|book cover only|resin|unpainted|painted|action figure|dreadknight|combat patrol|battleforce|sprue|on sprue|assembled|citadel miniature|plastic kit|model kit/i;
var knownAuthors = [
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
var bibliography = [
	{
		"names": ["Aurelian"],
		"authors": ["Aaron Dembski-Bowden"],
		"editions": [{
			"isbn": "9781849701068",
			"language": "EN",
			"format": "Hardback · Gold Edition",
			"source": "/catalog-source.pdf"
		}, {
			"isbn": "9781849702362",
			"language": "EN",
			"format": "Hardback · Silver Edition",
			"source": "/catalog-source.pdf"
		}]
	},
	{
		"names": ["Promethean Sun"],
		"authors": ["Nick Kyme"],
		"editions": [{
			"isbn": "9781849704793",
			"language": "EN",
			"format": "Hardback",
			"source": "/catalog-source.pdf"
		}]
	},
	{
		"names": ["Veterans of the Fall"],
		"authors": ["William Crowe"],
		"editions": [{
			"isbn": "9781836093053",
			"language": "EN",
			"format": "Paperback",
			"source": "/catalog-source.pdf"
		}]
	},
	{
		"names": ["Dropsite Massacre"],
		"authors": ["John French"],
		"editions": [{
			"isbn": "9781836092018",
			"language": "EN",
			"format": "Hardback",
			"source": "/catalog-source.pdf"
		}]
	},
	{
		"names": ["The Dark Coil: Ascension"],
		"authors": ["Peter Fehervari"],
		"editions": [{
			"isbn": "9781836090144",
			"language": "EN",
			"format": "Paperback",
			"source": "https://www.simonandschuster.com/books/The-Dark-Coil-Ascension/Peter-Fehervari/Warhammer-40-000/9781836090144"
		}]
	},
	{
		"names": ["The Dark Coil: Damnation"],
		"authors": ["Peter Fehervari"],
		"editions": [{
			"isbn": "9781836090007",
			"language": "EN",
			"format": "Paperback",
			"source": "https://www.simonandschuster.com/books/The-Dark-Coil-Damnation/Peter-Fehervari/Warhammer-40-000/9781836090007"
		}]
	},
	{
		"names": [
			"The Reverie",
			"Requiem Infernal",
			"Fire Caste",
			"Cult of the Spiral Dawn"
		],
		"authors": ["Peter Fehervari"],
		"editions": [],
		"source": "https://www.simonandschuster.com/books/The-Dark-Coil-Ascension/Peter-Fehervari/Warhammer-40-000/9781836090144"
	},
	{
		names: [
			"Night Lords: The Omnibus",
			"Soul Hunter",
			"Blood Reaver",
			"Void Stalker"
		],
		authors: ["Aaron Dembski-Bowden"],
		editions: [],
		source: "https://www.warhammer-community.com/en-gb/articles/gq1wmtzs/saturday-pre-orders-return-to-the-underworlds/"
	},
	{
		names: ["Betrayer", "Zdrajca"],
		authors: ["Aaron Dembski-Bowden"],
		editions: [],
		source: "https://www.blacklibrary.com/all-products/betrayer-ebook.html"
	},
	{
		names: ["Scars", "Szramy"],
		authors: ["Chris Wraight"],
		editions: [],
		source: "https://www.blacklibrary.com/the-horus-heresy/HH-Novel-Series/scars-ebook.html"
	},
	{
		names: ["Deliverance Lost", "Wybawienie utracone"],
		authors: ["Gav Thorpe"],
		editions: [],
		source: "https://www.blacklibrary.com/authors/gav-thorpe/deliverance-lost-ebook.html"
	},
	{
		names: ["Legion"],
		authors: ["Dan Abnett"],
		editions: [],
		source: "https://www.blacklibrary.com/all-products/legion-ebook.html"
	},
	{
		names: ["The First Heretic", "Pierwszy Heretyk"],
		authors: ["Aaron Dembski-Bowden"],
		editions: [],
		source: "https://www.blacklibrary.com/the-horus-heresy/novels/First-heretic-the-ebook-2016-updated.html"
	},
	{
		names: ["Horus Rising", "Wywyższenie Horusa"],
		authors: ["Dan Abnett"],
		editions: [{
			isbn: "9781844162949",
			language: "EN",
			format: "Paperback",
			source: "https://www.blacklibrary.com/downloads/product/pdf/h/horus-rising.pdf"
		}, {
			isbn: "9781836093145",
			language: "EN",
			format: "Paperback",
			source: "https://blackwells.co.uk/bookshop/product/Horus-Rising-by-Dan-Abnett/9781836093145"
		}]
	},
	{
		names: ["Fallen Angels", "Upadłe Anioły"],
		authors: ["Mike Lee"],
		editions: [{
			isbn: "9781849708104",
			language: "EN",
			format: "Paperback",
			source: "https://www.simonandschuster.com/books/Fallen-Angels/Mike-Lee/The-Horus-Heresy/9781849708104"
		}]
	},
	{
		names: ["Nemesis", "Nemezis"],
		authors: ["James Swallow"],
		editions: [{
			isbn: "9781849708234",
			language: "EN",
			format: "Paperback",
			source: "https://www.simonandschuster.com/books/Nemesis/James-Swallow/The-Horus-Heresy/9781849708234"
		}]
	}
];
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
	return bookMetadata([book.title, book.pl || ""])?.authors || knownAuthors.filter((a) => normalizeBookText((book.raw || "") + " " + (book.series || "")).includes(normalizeBookText(a)));
}
var warhammerContext = /\b(warhammer|40k|40 000|40000|black library|herezja|horus heresy|siege of terra)\b/;
var nonFictionProduct = /\b(codex|codices|battletome|rulebook|rule book|core rules|core book|army book|campaign book|campaign supplement|journal tactica|legions imperialis|liber hereticus|liber astartes|age of sigmar|warcry|warscroll|enchantment cards|transfer sheet|rpg|podrecznik|podreczniki|komiks|komiksy|comics?|manga|datasheets?|datacards?|miniatury|figurka|figurki|figurek|figurine|figurines|kaseta|kasety|cassette|vinyl|lipstick|pomadka|mascara|gold coins?|medal|moneta|monety|asg|gbbr|magazynki|zdalnie sterowany|zdalnego sterowania)\b/;
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
	return n.replace(/\b(paperback|hardback|hardcover|softcover|pb|hb|eng|english|pl|en|ksiazka|book|novel|nowy produkt|nowa|new|used|by|warhammer 40k|warhammer 40 000|warhammer 40000|warhammer|the horus heresy|horus heresy|siege of terra)\b/g, " ").replace(/\s+/g, " ").trim();
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
	const meta = bookMetadata(names), expected = evidence.authors?.length ? evidence.authors : meta?.authors || [];
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
	if (evidence.isbn && meta?.editions.some((e) => e.isbn === evidence.isbn.replace(/[^0-9X]/g, ""))) return {
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
		url: "https://vanaheim.pl/pl/557-ksiazki-warhammer-40000"
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
		url: "https://battlecult.pl/warhammer-40k",
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
		url: "https://rpg-piekielko.pl/pl/menu/warhammer-horus-heresy-3253.html",
		extraUrls: ["https://rpg-piekielko.pl/pl/menu/warhammer-40-000-3071.html"]
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
		url: "https://www.2d6.pl/pl/menu/ksiazki-black-library-warhammer-40k-556.html"
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
		url: "https://jaskiniatrolla.pl/Warhammer-40000-c675"
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
var additionalSearchUrl = (b, shop) => shop.search ? shop.search.replace("{q}", encodeQuery(shop.englishFirst ? b.title : b.pl || b.title, shop)) : shop.url;
function additionalSearchUrls(b, shop) {
	const first = additionalSearchUrl(b, shop);
	if (!shop.search || ![
		...listReaders,
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
	const isbn = attribute(main.match(/<[^>]+itemprop=["']gtin(?:13)?["'][^>]*>/i)?.[0] || "", "content");
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
	await runLimited([...urls].slice(0, 9).map((url) => async () => {
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
//#region lib/catalog.ts
var catalog = /* @__PURE__ */ JSON.parse("[{\"id\":\"b0001\",\"title\":\"Horus Rising\",\"pl\":\"Wywyższenie Horusa\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":1,\"raw\":\"Horus Rising · Horus Rising (PL: Wywyższenie Horusa)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Crusade’s End\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Crusade’s End\"],\"catalogMarker\":\"P\",\"readerOffset\":0,\"readerTitle\":\"Horus Rising\"},{\"id\":\"b0002\",\"title\":\"False Gods\",\"pl\":\"Fałszywi Bogowie\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":2,\"raw\":\"False Gods · False Gods (PL: Fałszywi Bogowie)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Crusade’s End\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Crusade’s End\"],\"catalogMarker\":\"P\",\"readerOffset\":1,\"readerTitle\":\"False Gods\"},{\"id\":\"b0003\",\"title\":\"Galaxy in Flames\",\"pl\":\"Galaktyka w płomieniach\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":3,\"raw\":\"Galaxy in Flames · Galaxy in Flames (PL: Galaktyka w płomieniach)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Crusade’s End\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Crusade’s End\"],\"catalogMarker\":\"P\",\"readerOffset\":2,\"readerTitle\":\"Galaxy in Flames\"},{\"id\":\"b0004\",\"title\":\"The Flight of the Eisenstein\",\"pl\":\"Ucieczka Eisensteina\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":4,\"raw\":\"The Flight of the Eisenstein · The Flight of the Eisenstein (PL: Ucieczka Eisensteina)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":3,\"readerTitle\":\"The Flight of the Eisenstein\"},{\"id\":\"b0005\",\"title\":\"Fulgrim\",\"pl\":\"Fulgrim\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":5,\"raw\":\"Fulgrim · Fulgrim (PL: Fulgrim)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Last Phoenix\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Last Phoenix\"],\"catalogMarker\":\"P\",\"readerOffset\":4,\"readerTitle\":\"Fulgrim\"},{\"id\":\"b0006\",\"title\":\"Descent of Angels\",\"pl\":\"Zstąpienie Aniołów\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":6,\"raw\":\"Descent of Angels · Descent of Angels (PL: Zstąpienie Aniołów)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":5,\"readerTitle\":\"Descent of Angels\"},{\"id\":\"b0007\",\"title\":\"Legion\",\"pl\":\"Legion\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":7,\"raw\":\"Legion · Legion (PL: Legion)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":6,\"readerTitle\":\"Legion\"},{\"id\":\"b0008\",\"title\":\"Battle for the Abyss\",\"pl\":\"Bitwa o Otchłań\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":8,\"raw\":\"Battle for the Abyss · Battle for the Abyss (PL: Bitwa o Otchłań)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":7,\"readerTitle\":\"Battle for the Abyss\"},{\"id\":\"b0009\",\"title\":\"Mechanicum\",\"pl\":\"Mechanicum\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":9,\"raw\":\"Mechanicum · Mechanicum (PL: Mechanicum)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":8,\"readerTitle\":\"Mechanicum\"},{\"id\":\"b0010\",\"title\":\"Tales of Heresy\",\"pl\":\"Z dziejów herezji\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":10,\"raw\":\"Tales of Heresy · Tales of Heresy (PL: Z dziejów herezji)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":9,\"readerTitle\":\"Tales of Heresy\"},{\"id\":\"b0011\",\"title\":\"Fallen Angels\",\"pl\":\"Upadłe Anioły\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":11,\"raw\":\"Fallen Angels · Fallen Angels (PL: Upadłe Anioły)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":10,\"readerTitle\":\"Fallen Angels\"},{\"id\":\"b0012\",\"title\":\"A Thousand Sons\",\"pl\":\"Tysiąc Synów\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":12,\"raw\":\"A Thousand Sons · A Thousand Sons (PL: Tysiąc Synów)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Razing of Prospero\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Razing of Prospero\"],\"catalogMarker\":\"P\",\"readerOffset\":11,\"readerTitle\":\"A Thousand Sons\"},{\"id\":\"b0013\",\"title\":\"Nemesis\",\"pl\":\"Nemezis\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":13,\"raw\":\"Nemesis · Nemesis (PL: Nemezis)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":12,\"readerTitle\":\"Nemesis\"},{\"id\":\"b0014\",\"title\":\"The First Heretic\",\"pl\":\"Pierwszy Heretyk\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":14,\"raw\":\"The First Heretic · The First Heretic (PL: Pierwszy Heretyk)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":13,\"readerTitle\":\"The First Heretic\"},{\"id\":\"b0015\",\"title\":\"Prospero Burns\",\"pl\":\"Prospero w płomieniach\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":15,\"raw\":\"Prospero Burns · Prospero Burns (PL: Prospero w płomieniach)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Razing of Prospero\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Razing of Prospero\"],\"catalogMarker\":\"P\",\"readerOffset\":14,\"readerTitle\":\"Prospero Burns\"},{\"id\":\"b0016\",\"title\":\"Age of Darkness\",\"pl\":\"Era Mroku\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":16,\"raw\":\"Age of Darkness · Age of Darkness (PL: Era Mroku)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":15,\"readerTitle\":\"Age of Darkness\"},{\"id\":\"b0017\",\"title\":\"The Outcast Dead\",\"pl\":\"Potępieńcy\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":17,\"raw\":\"The Outcast Dead · The Outcast Dead (PL: Potępieńcy)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":16,\"readerTitle\":\"The Outcast Dead\"},{\"id\":\"b0018\",\"title\":\"Deliverance Lost\",\"pl\":\"Wybawienie utracone\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":18,\"raw\":\"Deliverance Lost · Deliverance Lost (PL: Wybawienie utracone)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":17,\"readerTitle\":\"Deliverance Lost\"},{\"id\":\"b0019\",\"title\":\"Know No Fear\",\"pl\":\"…I nie poznają co to strach\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":19,\"raw\":\"Know No Fear · Know No Fear (PL: …I nie poznają co to strach)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":18,\"readerTitle\":\"Know No Fear\"},{\"id\":\"b0020\",\"title\":\"The Primarchs\",\"pl\":\"Prymarchowie\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":20,\"raw\":\"The Primarchs · The Primarchs (PL: Prymarchowie)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":19,\"readerTitle\":\"The Primarchs\"},{\"id\":\"b0021\",\"title\":\"Fear to Tread\",\"pl\":\"Krocząc w strachu\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":21,\"raw\":\"Fear to Tread · Fear to Tread (PL: Krocząc w strachu)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":20,\"readerTitle\":\"Fear to Tread\"},{\"id\":\"b0022\",\"title\":\"Shadows of Treachery\",\"pl\":\"Cienie zdrady\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":22,\"raw\":\"Shadows of Treachery · Shadows of Treachery (PL: Cienie zdrady)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":21,\"readerTitle\":\"Shadows of Treachery\"},{\"id\":\"b0023\",\"title\":\"Angel Exterminatus\",\"pl\":\"Angel Exterminatus\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":23,\"raw\":\"Angel Exterminatus · Angel Exterminatus (PL: Angel Exterminatus)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Last Phoenix\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Last Phoenix\"],\"catalogMarker\":\"P\",\"readerOffset\":22,\"readerTitle\":\"Angel Exterminatus\"},{\"id\":\"b0024\",\"title\":\"Betrayer\",\"pl\":\"Zdrajca\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":24,\"raw\":\"Betrayer · Betrayer (PL: Zdrajca)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":23,\"readerTitle\":\"Betrayer\"},{\"id\":\"b0025\",\"title\":\"Mark of Calth\",\"pl\":\"Piętno Calth\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":25,\"raw\":\"Mark of Calth · Mark of Calth (PL: Piętno Calth)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":24,\"readerTitle\":\"Mark of Calth\"},{\"id\":\"b0026\",\"title\":\"Vulkan Lives\",\"pl\":\"Vulkan Żyje\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":26,\"raw\":\"Vulkan Lives · Vulkan Lives (PL: Vulkan Żyje)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":25,\"readerTitle\":\"Vulkan Lives\"},{\"id\":\"b0027\",\"title\":\"The Unremembered Empire\",\"pl\":\"Niezapamiętane Imperium\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":27,\"raw\":\"The Unremembered Empire · The Unremembered Empire (PL: Niezapamiętane Imperium)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":26,\"readerTitle\":\"The Unremembered Empire\"},{\"id\":\"b0028\",\"title\":\"Scars\",\"pl\":\"Szramy\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":28,\"raw\":\"Scars · Scars (PL: Szramy)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":27,\"readerTitle\":\"Scars\"},{\"id\":\"b0029\",\"title\":\"Vengeful Spirit\",\"pl\":\"Mściwy Duch\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":29,\"raw\":\"Vengeful Spirit · Vengeful Spirit (PL: Mściwy Duch)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":28,\"readerTitle\":\"Vengeful Spirit\"},{\"id\":\"b0030\",\"title\":\"The Damnation of Pythos\",\"pl\":\"Przekleństwo Pythosa\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":30,\"raw\":\"The Damnation of Pythos · The Damnation of Pythos (PL: Przekleństwo Pythosa)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":29,\"readerTitle\":\"The Damnation of Pythos\"},{\"id\":\"b0031\",\"title\":\"Legacies of Betrayal\",\"pl\":\"Spuścizna Zdrady\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":31,\"raw\":\"Legacies of Betrayal · Legacies of Betrayal (PL: Spuścizna Zdrady)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":30,\"readerTitle\":\"Legacies of Betrayal\"},{\"id\":\"b0032\",\"title\":\"Deathfire\",\"pl\":\"Ogień Śmierci\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":32,\"raw\":\"Deathfire · Deathfire (PL: Ogień Śmierci)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":31,\"readerTitle\":\"Deathfire\"},{\"id\":\"b0033\",\"title\":\"War Without End\",\"pl\":\"Wojna bez końca\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":33,\"raw\":\"War Without End · War Without End (PL: Wojna bez końca)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":32,\"readerTitle\":\"War Without End\"},{\"id\":\"b0034\",\"title\":\"Pharos\",\"pl\":\"Pharos\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":34,\"raw\":\"Pharos · Pharos (PL: Pharos)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":33,\"readerTitle\":\"Pharos\"},{\"id\":\"b0035\",\"title\":\"Eye of Terra\",\"pl\":\"Oko Terry\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":35,\"raw\":\"Eye of Terra · Eye of Terra (PL: Oko Terry)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":34,\"readerTitle\":\"Eye of Terra\"},{\"id\":\"b0036\",\"title\":\"The Path of Heaven\",\"pl\":\"Ścieżka Niebios\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":36,\"raw\":\"The Path of Heaven · The Path of Heaven (PL: Ścieżka Niebios)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":35,\"readerTitle\":\"The Path of Heaven\"},{\"id\":\"b0037\",\"title\":\"The Silent War\",\"pl\":\"Cicha Wojna\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":37,\"raw\":\"The Silent War · The Silent War (PL: Cicha Wojna)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":36,\"readerTitle\":\"The Silent War\"},{\"id\":\"b0038\",\"title\":\"Angels of Caliban\",\"pl\":\"Anioły z Calibana\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":38,\"raw\":\"Angels of Caliban · Angels of Caliban (PL: Anioły z Calibana)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":37,\"readerTitle\":\"Angels of Caliban\"},{\"id\":\"b0039\",\"title\":\"Praetorian of Dorn\",\"pl\":\"Pretorianin Dorna\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":39,\"raw\":\"Praetorian of Dorn · Praetorian of Dorn (PL: Pretorianin Dorna)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":38,\"readerTitle\":\"Praetorian of Dorn\"},{\"id\":\"b0040\",\"title\":\"Corax\",\"pl\":\"Corax\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":40,\"raw\":\"Corax · Corax (PL: Corax)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":39,\"readerTitle\":\"Corax\"},{\"id\":\"b0041\",\"title\":\"The Master of Mankind\",\"pl\":\"Władca Ludzkości\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":41,\"raw\":\"The Master of Mankind · The Master of Mankind (PL: Władca Ludzkości)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":40,\"readerTitle\":\"The Master of Mankind\"},{\"id\":\"b0042\",\"title\":\"Garro\",\"pl\":\"Garro\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":42,\"raw\":\"Garro · Garro (PL: Garro)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":41,\"readerTitle\":\"Garro\"},{\"id\":\"b0043\",\"title\":\"Shattered Legions\",\"pl\":\"Rozbite Legiony\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":43,\"raw\":\"Shattered Legions · Shattered Legions (PL: Rozbite Legiony)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":42,\"readerTitle\":\"Shattered Legions\"},{\"id\":\"b0044\",\"title\":\"The Crimson King\",\"pl\":\"Karmazynowy Król\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":44,\"raw\":\"The Crimson King · The Crimson King (PL: Karmazynowy Król)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":43,\"readerTitle\":\"The Crimson King\"},{\"id\":\"b0045\",\"title\":\"Tallarn\",\"pl\":\"Tallarn\",\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":45,\"raw\":\"Tallarn · Tallarn (PL: Tallarn)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":44,\"readerTitle\":\"Tallarn\"},{\"id\":\"b0046\",\"title\":\"Ruinstorm\",\"pl\":null,\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":46,\"raw\":\"Ruinstorm\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":45,\"readerTitle\":\"Ruinstorm\"},{\"id\":\"b0047\",\"title\":\"Old Earth\",\"pl\":null,\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":47,\"raw\":\"Old Earth\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":46,\"readerTitle\":\"Old Earth\"},{\"id\":\"b0048\",\"title\":\"The Burden of Loyalty\",\"pl\":null,\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":48,\"raw\":\"The Burden of Loyalty\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":47,\"readerTitle\":\"The Burden of Loyalty\"},{\"id\":\"b0049\",\"title\":\"Wolfsbane\",\"pl\":null,\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":49,\"raw\":\"Wolfsbane\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":48,\"readerTitle\":\"Wolfsbane\"},{\"id\":\"b0050\",\"title\":\"Born of Flame\",\"pl\":null,\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":50,\"raw\":\"Born of Flame\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":49,\"readerTitle\":\"Born of Flame\"},{\"id\":\"b0051\",\"title\":\"Slaves to Darkness\",\"pl\":null,\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":51,\"raw\":\"Slaves to Darkness\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":50,\"readerTitle\":\"Slaves to Darkness\"},{\"id\":\"b0052\",\"title\":\"Heralds of the Siege\",\"pl\":null,\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":52,\"raw\":\"Heralds of the Siege\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":51,\"readerTitle\":\"Heralds of the Siege\"},{\"id\":\"b0053\",\"title\":\"Titandeath\",\"pl\":null,\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":53,\"raw\":\"Titandeath\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":52,\"readerTitle\":\"Titandeath\"},{\"id\":\"b0054\",\"title\":\"The Buried Dagger\",\"pl\":null,\"series\":\"HORUS HERESY - 54 TOMY\",\"number\":54,\"raw\":\"The Buried Dagger\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":53,\"readerTitle\":\"The Buried Dagger\"},{\"id\":\"b0055\",\"title\":\"The Solar War\",\"pl\":null,\"series\":\"SIEGE OF TERRA\",\"number\":1,\"raw\":\"The Solar War\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":54,\"readerTitle\":\"The Solar War\"},{\"id\":\"b0056\",\"title\":\"The Lost and the Damned\",\"pl\":null,\"series\":\"SIEGE OF TERRA\",\"number\":2,\"raw\":\"The Lost and the Damned\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":55,\"readerTitle\":\"The Lost and the Damned\"},{\"id\":\"b0057\",\"title\":\"The First Wall\",\"pl\":null,\"series\":\"SIEGE OF TERRA\",\"number\":3,\"raw\":\"The First Wall\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":56,\"readerTitle\":\"The First Wall\"},{\"id\":\"b0058\",\"title\":\"Saturnine\",\"pl\":null,\"series\":\"SIEGE OF TERRA\",\"number\":4,\"raw\":\"Saturnine\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":57,\"readerTitle\":\"Saturnine\"},{\"id\":\"b0059\",\"title\":\"Mortis\",\"pl\":null,\"series\":\"SIEGE OF TERRA\",\"number\":5,\"raw\":\"Mortis\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":58,\"readerTitle\":\"Mortis\"},{\"id\":\"b0060\",\"title\":\"Warhawk\",\"pl\":null,\"series\":\"SIEGE OF TERRA\",\"number\":6,\"raw\":\"Warhawk\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":59,\"readerTitle\":\"Warhawk\"},{\"id\":\"b0061\",\"title\":\"Echoes of Eternity\",\"pl\":null,\"series\":\"SIEGE OF TERRA\",\"number\":7,\"raw\":\"Echoes of Eternity\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":60,\"readerTitle\":\"Echoes of Eternity\"},{\"id\":\"b0062\",\"title\":\"The End and the Death: Volume I\",\"pl\":null,\"series\":\"SIEGE OF TERRA\",\"number\":8,\"raw\":\"The End and the Death: Volume I\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":61,\"readerTitle\":\"The End and the Death: Volume I\"},{\"id\":\"b0063\",\"title\":\"The End and the Death: Volume II\",\"pl\":null,\"series\":\"SIEGE OF TERRA\",\"number\":9,\"raw\":\"The End and the Death: Volume II\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":62,\"readerTitle\":\"The End and the Death: Volume II\"},{\"id\":\"b0064\",\"title\":\"The End and the Death: Volume III\",\"pl\":null,\"series\":\"SIEGE OF TERRA\",\"number\":10,\"raw\":\"The End and the Death: Volume III\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":63,\"readerTitle\":\"The End and the Death: Volume III\"},{\"id\":\"b0065\",\"title\":\"Roboute Guilliman: Lord of Ultramar\",\"pl\":\"Roboute Guilliman: Władca Ultramaru\",\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Roboute Guilliman: Lord of Ultramar · Roboute Guilliman: Lord of Ultramar (PL: Roboute Guilliman: Władca Ultramaru)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":64,\"readerTitle\":\"Roboute Guilliman: Lord of Ultramar\"},{\"id\":\"b0066\",\"title\":\"Leman Russ: The Great Wolf\",\"pl\":\"Leman Russ: Wielki Wilk\",\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Leman Russ: The Great Wolf · Leman Russ: The Great Wolf (PL: Leman Russ: Wielki Wilk)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":65,\"readerTitle\":\"Leman Russ: The Great Wolf\"},{\"id\":\"b0067\",\"title\":\"Magnus the Red: Master of Prospero\",\"pl\":\"Magnus Czerwony: Władca Prospero\",\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Magnus the Red: Master of Prospero · Magnus the Red: Master of Prospero (PL: Magnus Czerwony: Władca Prospero)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":66,\"readerTitle\":\"Magnus the Red: Master of Prospero\"},{\"id\":\"b0068\",\"title\":\"Perturabo: The Hammer of Olympia\",\"pl\":\"Perturabo: Młot Olympii\",\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Perturabo: The Hammer of Olympia · Perturabo: The Hammer of Olympia (PL: Perturabo: Młot Olympii)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":67,\"readerTitle\":\"Perturabo: The Hammer of Olympia\"},{\"id\":\"b0069\",\"title\":\"Lorgar: Bearer of the Word\",\"pl\":\"Lorgar: Głosiciel Słowa\",\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Lorgar: Bearer of the Word · Lorgar: Bearer of the Word (PL: Lorgar: Głosiciel Słowa)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":68,\"readerTitle\":\"Lorgar: Bearer of the Word\"},{\"id\":\"b0070\",\"title\":\"Fulgrim: The Palatine Phoenix\",\"pl\":\"Fulgrim: Feniks Palatyński\",\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Fulgrim: The Palatine Phoenix · Fulgrim: The Palatine Phoenix (PL: Fulgrim: Feniks Palatyński)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":69,\"readerTitle\":\"Fulgrim: The Palatine Phoenix\"},{\"id\":\"b0071\",\"title\":\"Ferrus Manus: The Gorgon of Medusa\",\"pl\":\"Ferrus Manus: Gorgon z Meduzy\",\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Ferrus Manus: The Gorgon of Medusa · Ferrus Manus: The Gorgon of Medusa (PL: Ferrus Manus: Gorgon z Meduzy)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":70,\"readerTitle\":\"Ferrus Manus: The Gorgon of Medusa\"},{\"id\":\"b0072\",\"title\":\"Jaghatai Khan: Warhawk of Chogoris\",\"pl\":\"Jaghatai Khan: Sokół z Chogoris\",\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Jaghatai Khan: Warhawk of Chogoris · Jaghatai Khan: Warhawk of Chogoris (PL: Jaghatai Khan: Sokół z Chogoris)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":71,\"readerTitle\":\"Jaghatai Khan: Warhawk of Chogoris\"},{\"id\":\"b0073\",\"title\":\"Vulkan: Lord of Drakes\",\"pl\":\"Vulkan: Władca Smoków\",\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Vulkan: Lord of Drakes · Vulkan: Lord of Drakes (PL: Vulkan: Władca Smoków)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":72,\"readerTitle\":\"Vulkan: Lord of Drakes\"},{\"id\":\"b0074\",\"title\":\"Corax: Lord of Shadows\",\"pl\":\"Corax: Władca Cieni\",\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Corax: Lord of Shadows · Corax: Lord of Shadows (PL: Corax: Władca Cieni)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":73,\"readerTitle\":\"Corax: Lord of Shadows\"},{\"id\":\"b0075\",\"title\":\"Angron: Slave of Nuceria\",\"pl\":\"Angron: Niewolnik z Nucerii\",\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Angron: Slave of Nuceria · Angron: Slave of Nuceria (PL: Angron: Niewolnik z Nucerii)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":74,\"readerTitle\":\"Angron: Slave of Nuceria\"},{\"id\":\"b0076\",\"title\":\"Konrad Curze: The Night Haunter\",\"pl\":\"Konrad Curze: Nocny Upiór\",\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Konrad Curze: The Night Haunter · Konrad Curze: The Night Haunter (PL: Konrad Curze: Nocny Upiór)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":75,\"readerTitle\":\"Konrad Curze: The Night Haunter\"},{\"id\":\"b0077\",\"title\":\"Lion El'Jonson: Lord of the First\",\"pl\":\"Lion El'Jonson: Władca Pierwszego\",\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Lion El'Jonson: Lord of the First · Lion El'Jonson: Lord of the First (PL: Lion El'Jonson: Władca Pierwszego)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":76,\"readerTitle\":\"Lion El'Jonson: Lord of the First\"},{\"id\":\"b0078\",\"title\":\"Alpharius: Head of the Hydra\",\"pl\":null,\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Alpharius: Head of the Hydra\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":77,\"readerTitle\":\"Alpharius: Head of the Hydra\"},{\"id\":\"b0079\",\"title\":\"Mortarion: The Pale King\",\"pl\":null,\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Mortarion: The Pale King\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":78,\"readerTitle\":\"Mortarion: The Pale King\"},{\"id\":\"b0080\",\"title\":\"Rogal Dorn: The Emperor's Crusader\",\"pl\":null,\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Rogal Dorn: The Emperor's Crusader\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":79,\"readerTitle\":\"Rogal Dorn: The Emperor's Crusader\"},{\"id\":\"b0081\",\"title\":\"Sanguinius: The Great Angel\",\"pl\":null,\"series\":\"HORUS HERESY: PRIMARCHS\",\"number\":null,\"raw\":\"Sanguinius: The Great Angel\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":80,\"readerTitle\":\"Sanguinius: The Great Angel\"},{\"id\":\"b0082\",\"title\":\"Valdor: Birth of the Imperium\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Valdor: Birth of the Imperium\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":81,\"readerTitle\":\"Valdor: Birth of the Imperium\"},{\"id\":\"b0083\",\"title\":\"Luther: First of the Fallen\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Luther: First of the Fallen\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":82,\"readerTitle\":\"Luther: First of the Fallen\"},{\"id\":\"b0084\",\"title\":\"Sigismund: The Eternal Crusader\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Sigismund: The Eternal Crusader\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":83,\"readerTitle\":\"Sigismund: The Eternal Crusader\"},{\"id\":\"b0085\",\"title\":\"Eidolon: The Auric Hammer\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Eidolon: The Auric Hammer\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":84,\"readerTitle\":\"Eidolon: The Auric Hammer\"},{\"id\":\"b0086\",\"title\":\"Zardu Layak: The Crimson Apostle\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Zardu Layak: The Crimson Apostle\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":85,\"readerTitle\":\"Zardu Layak: The Crimson Apostle\"},{\"id\":\"b0087\",\"title\":\"Raldoron: Revenant\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Raldoron: Revenant\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":86,\"readerTitle\":\"Raldoron: Revenant\"},{\"id\":\"b0088\",\"title\":\"Sons of the Selenar\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Sons of the Selenar\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":87,\"readerTitle\":\"Sons of the Selenar\"},{\"id\":\"b0089\",\"title\":\"Fury of Magnus\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Fury of Magnus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":88,\"readerTitle\":\"Fury of Magnus\"},{\"id\":\"b0090\",\"title\":\"Garro: Knight of Grey\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Garro: Knight of Grey\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":89,\"readerTitle\":\"Garro: Knight of Grey\"},{\"id\":\"b0091\",\"title\":\"Dropsite Massacre\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Dropsite Massacre\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":90,\"readerTitle\":\"Dropsite Massacre\"},{\"id\":\"b0092\",\"title\":\"Ashes of the Imperium\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Ashes of the Imperium\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":91,\"readerTitle\":\"Ashes of the Imperium\"},{\"id\":\"b0093\",\"title\":\"Era of Ruin\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Era of Ruin · Era of Ruin (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":92,\"readerTitle\":\"Era of Ruin\"},{\"id\":\"b0094\",\"title\":\"Sons of the Emperor\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Sons of the Emperor · Sons of the Emperor (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":93,\"readerTitle\":\"Sons of the Emperor\"},{\"id\":\"b0095\",\"title\":\"Scions of the Emperor\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Scions of the Emperor · Scions of the Emperor (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":94,\"readerTitle\":\"Scions of the Emperor\"},{\"id\":\"b0096\",\"title\":\"Blood of the Emperor\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Blood of the Emperor · Blood of the Emperor (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":95,\"readerTitle\":\"Blood of the Emperor\"},{\"id\":\"b0097\",\"title\":\"Lupercal's War\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Lupercal's War · Lupercal's War (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":96,\"readerTitle\":\"Lupercal's War\"},{\"id\":\"b0098\",\"title\":\"Cthonia's Reckoning\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Cthonia's Reckoning · Cthonia's Reckoning (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":97,\"readerTitle\":\"Cthonia's Reckoning\"},{\"id\":\"b0102\",\"title\":\"Crusade's End\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"Crusade's End · Crusade's End (omnibus: Horus Rising, False Gods, Galaxy in Flames)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. \\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Horus Rising\",\"False Gods\",\"Galaxy in Flames\"],\"readerOffset\":101,\"readerTitle\":\"Crusade's End\"},{\"id\":\"b0103\",\"title\":\"The Last Phoenix\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"The Last Phoenix · The Last Phoenix (omnibus: Fulgrim, Angel Exterminatus)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. \\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Fulgrim\",\"Angel Exterminatus\"],\"readerOffset\":102,\"readerTitle\":\"The Last Phoenix\"},{\"id\":\"b0104\",\"title\":\"The Razing of Prospero\",\"pl\":null,\"series\":\"HORUS HERESY - DODATKI\",\"number\":null,\"raw\":\"The Razing of Prospero · The Razing of Prospero (omnibus: A Thousand Sons, Prospero Burns)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. \\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"A Thousand Sons\",\"Prospero Burns\"],\"readerOffset\":103,\"readerTitle\":\"The Razing of Prospero\"},{\"id\":\"b0105\",\"title\":\"I Am Slaughter\",\"pl\":null,\"series\":\"THE BEAST ARISES\",\"number\":1,\"raw\":\"I Am Slaughter\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Beast Arises: Volume 1\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Beast Arises: Volume 1\"],\"catalogMarker\":\"P\",\"readerOffset\":104,\"readerTitle\":\"I Am Slaughter\"},{\"id\":\"b0106\",\"title\":\"Predator, Prey\",\"pl\":null,\"series\":\"THE BEAST ARISES\",\"number\":2,\"raw\":\"Predator, Prey\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Beast Arises: Volume 1\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Beast Arises: Volume 1\"],\"catalogMarker\":\"P\",\"readerOffset\":105,\"readerTitle\":\"Predator, Prey\"},{\"id\":\"b0107\",\"title\":\"The Emperor Expects\",\"pl\":null,\"series\":\"THE BEAST ARISES\",\"number\":3,\"raw\":\"The Emperor Expects\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Beast Arises: Volume 1\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Beast Arises: Volume 1\"],\"catalogMarker\":\"P\",\"readerOffset\":106,\"readerTitle\":\"The Emperor Expects\"},{\"id\":\"b0108\",\"title\":\"The Last Wall\",\"pl\":null,\"series\":\"THE BEAST ARISES\",\"number\":4,\"raw\":\"The Last Wall\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Beast Arises: Volume 1\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Beast Arises: Volume 1\"],\"catalogMarker\":\"P\",\"readerOffset\":107,\"readerTitle\":\"The Last Wall\"},{\"id\":\"b0109\",\"title\":\"Throneworld\",\"pl\":null,\"series\":\"THE BEAST ARISES\",\"number\":5,\"raw\":\"Throneworld\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Beast Arises: Volume 2\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Beast Arises: Volume 2\"],\"catalogMarker\":\"P\",\"readerOffset\":108,\"readerTitle\":\"Throneworld\"},{\"id\":\"b0110\",\"title\":\"Echoes of the Long War\",\"pl\":null,\"series\":\"THE BEAST ARISES\",\"number\":6,\"raw\":\"Echoes of the Long War\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Beast Arises: Volume 2\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Beast Arises: Volume 2\"],\"catalogMarker\":\"P\",\"readerOffset\":109,\"readerTitle\":\"Echoes of the Long War\"},{\"id\":\"b0111\",\"title\":\"The Hunt for Vulkan\",\"pl\":null,\"series\":\"THE BEAST ARISES\",\"number\":7,\"raw\":\"The Hunt for Vulkan\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Beast Arises: Volume 2\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Beast Arises: Volume 2\"],\"catalogMarker\":\"P\",\"readerOffset\":110,\"readerTitle\":\"The Hunt for Vulkan\"},{\"id\":\"b0112\",\"title\":\"The Beast Must Die\",\"pl\":null,\"series\":\"THE BEAST ARISES\",\"number\":8,\"raw\":\"The Beast Must Die\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Beast Arises: Volume 2\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Beast Arises: Volume 2\"],\"catalogMarker\":\"P\",\"readerOffset\":111,\"readerTitle\":\"The Beast Must Die\"},{\"id\":\"b0113\",\"title\":\"Watchers in Death\",\"pl\":null,\"series\":\"THE BEAST ARISES\",\"number\":9,\"raw\":\"Watchers in Death\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Beast Arises: Volume 3\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Beast Arises: Volume 3\"],\"catalogMarker\":\"P\",\"readerOffset\":112,\"readerTitle\":\"Watchers in Death\"},{\"id\":\"b0114\",\"title\":\"The Last Son of Dorn\",\"pl\":null,\"series\":\"THE BEAST ARISES\",\"number\":10,\"raw\":\"The Last Son of Dorn\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Beast Arises: Volume 3\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Beast Arises: Volume 3\"],\"catalogMarker\":\"P\",\"readerOffset\":113,\"readerTitle\":\"The Last Son of Dorn\"},{\"id\":\"b0115\",\"title\":\"Shadow of Ullanor\",\"pl\":null,\"series\":\"THE BEAST ARISES\",\"number\":11,\"raw\":\"Shadow of Ullanor\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Beast Arises: Volume 3\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Beast Arises: Volume 3\"],\"catalogMarker\":\"P\",\"readerOffset\":114,\"readerTitle\":\"Shadow of Ullanor\"},{\"id\":\"b0116\",\"title\":\"The Beheading\",\"pl\":null,\"series\":\"THE BEAST ARISES\",\"number\":12,\"raw\":\"The Beheading\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Beast Arises: Volume 3\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Beast Arises: Volume 3\"],\"catalogMarker\":\"P\",\"readerOffset\":115,\"readerTitle\":\"The Beheading\"},{\"id\":\"b0117\",\"title\":\"First and Only\",\"pl\":\"Pierwszy i jedyny z Tanith\",\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":1,\"raw\":\"First and Only · First and Only (PL: Pierwszy i jedyny z Tanith)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Founding\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Founding\"],\"catalogMarker\":\"P\",\"readerOffset\":116,\"readerTitle\":\"First and Only\"},{\"id\":\"b0118\",\"title\":\"Ghostmaker\",\"pl\":null,\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":2,\"raw\":\"Ghostmaker · Ghostmaker (PL: Komisarz Gaunt – (?) dopasowane po numerze tomu)\",\"uncertain\":true,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Founding\\nUWAGA: Polskie tłumaczenie tytułu w oryginale wymaga potwierdzenia; nie utożsamiać automatycznie z nazwą całej serii.\\nPolski tytuł z PDF: Komisarz Gaunt — dopasowanie niepotwierdzone.\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Founding\"],\"catalogMarker\":\"P\",\"readerOffset\":117,\"readerTitle\":\"Ghostmaker\"},{\"id\":\"b0119\",\"title\":\"Necropolis\",\"pl\":\"Nekropolia\",\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":3,\"raw\":\"Necropolis · Necropolis (PL: Nekropolia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Founding\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Founding\"],\"catalogMarker\":\"P\",\"readerOffset\":118,\"readerTitle\":\"Necropolis\"},{\"id\":\"b0120\",\"title\":\"Honour Guard\",\"pl\":\"Gwardia Honorowa\",\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":4,\"raw\":\"Honour Guard · Honour Guard (PL: Gwardia Honorowa)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Saint\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Gaunt’s Ghosts: The Saint\"],\"catalogMarker\":\"P\",\"readerOffset\":119,\"readerTitle\":\"Honour Guard\"},{\"id\":\"b0121\",\"title\":\"The Guns of Tanith\",\"pl\":\"Karabiny Tanith\",\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":5,\"raw\":\"The Guns of Tanith · The Guns of Tanith (PL: Karabiny Tanith)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Saint\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Gaunt’s Ghosts: The Saint\"],\"catalogMarker\":\"P\",\"readerOffset\":120,\"readerTitle\":\"The Guns of Tanith\"},{\"id\":\"b0122\",\"title\":\"Straight Silver\",\"pl\":\"Czyste Srebro\",\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":6,\"raw\":\"Straight Silver · Straight Silver (PL: Czyste Srebro)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Saint\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Gaunt’s Ghosts: The Saint\"],\"catalogMarker\":\"P\",\"readerOffset\":121,\"readerTitle\":\"Straight Silver\"},{\"id\":\"b0123\",\"title\":\"Sabbat Martyr\",\"pl\":\"Męczeństwo Sabbat\",\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":7,\"raw\":\"Sabbat Martyr · Sabbat Martyr (PL: Męczeństwo Sabbat)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Saint\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Gaunt’s Ghosts: The Saint\"],\"catalogMarker\":\"P\",\"readerOffset\":122,\"readerTitle\":\"Sabbat Martyr\"},{\"id\":\"b0124\",\"title\":\"Traitor General\",\"pl\":\"Zdradziecki Generał\",\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":8,\"raw\":\"Traitor General · Traitor General (PL: Zdradziecki Generał)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Lost\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Lost\"],\"catalogMarker\":\"P\",\"readerOffset\":123,\"readerTitle\":\"Traitor General\"},{\"id\":\"b0125\",\"title\":\"His Last Command\",\"pl\":\"Ostatni Rozkaz\",\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":9,\"raw\":\"His Last Command · His Last Command (PL: Ostatni Rozkaz)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Lost\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Lost\"],\"catalogMarker\":\"P\",\"readerOffset\":124,\"readerTitle\":\"His Last Command\"},{\"id\":\"b0126\",\"title\":\"The Armour of Contempt\",\"pl\":\"Pancerz Pogardy\",\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":10,\"raw\":\"The Armour of Contempt · The Armour of Contempt (PL: Pancerz Pogardy)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Lost\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Lost\"],\"catalogMarker\":\"P\",\"readerOffset\":125,\"readerTitle\":\"The Armour of Contempt\"},{\"id\":\"b0127\",\"title\":\"Only in Death\",\"pl\":\"Tylko śmierć\",\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":11,\"raw\":\"Only in Death · Only in Death (PL: Tylko śmierć)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Lost\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Lost\"],\"catalogMarker\":\"P\",\"readerOffset\":126,\"readerTitle\":\"Only in Death\"},{\"id\":\"b0128\",\"title\":\"Blood Pact\",\"pl\":\"Krwawy Pakt\",\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":12,\"raw\":\"Blood Pact · Blood Pact (PL: Krwawy Pakt)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":127,\"readerTitle\":\"Blood Pact\"},{\"id\":\"b0129\",\"title\":\"Salvation's Reach\",\"pl\":\"Stacja „Ocalenie\\\"\",\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":13,\"raw\":\"Salvation's Reach · Salvation's Reach (PL: Stacja „Ocalenie\\\")\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":128,\"readerTitle\":\"Salvation's Reach\"},{\"id\":\"b0130\",\"title\":\"The Warmaster\",\"pl\":\"Mistrz Wojny\",\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":14,\"raw\":\"The Warmaster · The Warmaster (PL: Mistrz Wojny)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Victory\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Gaunt's Ghosts: The Victory (Part Two)\"],\"catalogMarker\":\"P\",\"readerOffset\":129,\"readerTitle\":\"The Warmaster\"},{\"id\":\"b0131\",\"title\":\"Anarch\",\"pl\":\"Anarch\",\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":15,\"raw\":\"Anarch · Anarch (PL: Anarch)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Victory\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Gaunt's Ghosts: The Victory (Part Two)\"],\"catalogMarker\":\"P\",\"readerOffset\":130,\"readerTitle\":\"Anarch\"},{\"id\":\"b0132\",\"title\":\"Gaunt’s Ghosts: The Saint\",\"pl\":null,\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":null,\"raw\":\"Gaunt’s Ghosts: The Saint · The Saint (?)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. UWAGA: To omnibus, nie tom 16 serii Gaunt’s Ghosts.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Honour Guard\",\"The Guns of Tanith\",\"Straight Silver\",\"Sabbat Martyr\"],\"readerOffset\":131,\"readerTitle\":\"The Saint\"},{\"id\":\"b0133\",\"title\":\"The Vincula Insurgency\",\"pl\":null,\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":null,\"raw\":\"The Vincula Insurgency · Ghost Dossier 1: The Vincula Insurgency\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":132,\"readerTitle\":\"Ghost Dossier 1: The Vincula Insurgency\"},{\"id\":\"b0134\",\"title\":\"Sabbat Worlds\",\"pl\":null,\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":null,\"raw\":\"Sabbat Worlds · Sabbat Worlds (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":133,\"readerTitle\":\"Sabbat Worlds\"},{\"id\":\"b0135\",\"title\":\"Sabbat Crusade\",\"pl\":null,\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":null,\"raw\":\"Sabbat Crusade · Sabbat Crusade (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":134,\"readerTitle\":\"Sabbat Crusade\"},{\"id\":\"b0136\",\"title\":\"Sabbat War\",\"pl\":null,\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":null,\"raw\":\"Sabbat War · Sabbat War (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":135,\"readerTitle\":\"Sabbat War\"},{\"id\":\"b0137\",\"title\":\"Double Eagle\",\"pl\":null,\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":null,\"raw\":\"Double Eagle\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":136,\"readerTitle\":\"Double Eagle\"},{\"id\":\"b0138\",\"title\":\"Interceptor City\",\"pl\":null,\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":null,\"raw\":\"Interceptor City\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":137,\"readerTitle\":\"Interceptor City\"},{\"id\":\"b0139\",\"title\":\"Xenos\",\"pl\":\"Xenos\",\"series\":\"EISENHORN / RAVENOR / BEQUIN\",\"number\":null,\"raw\":\"Xenos · Xenos (PL: Xenos)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Eisenhorn: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Eisenhorn: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":138,\"readerTitle\":\"Xenos\"},{\"id\":\"b0140\",\"title\":\"Malleus\",\"pl\":\"Malleus\",\"series\":\"EISENHORN / RAVENOR / BEQUIN\",\"number\":null,\"raw\":\"Malleus · Malleus (PL: Malleus)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Eisenhorn: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Eisenhorn: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":139,\"readerTitle\":\"Malleus\"},{\"id\":\"b0141\",\"title\":\"Hereticus\",\"pl\":\"Hereticus\",\"series\":\"EISENHORN / RAVENOR / BEQUIN\",\"number\":null,\"raw\":\"Hereticus · Hereticus (PL: Hereticus)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Eisenhorn: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Eisenhorn: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":140,\"readerTitle\":\"Hereticus\"},{\"id\":\"b0142\",\"title\":\"The Magos\",\"pl\":null,\"series\":\"EISENHORN / RAVENOR / BEQUIN\",\"number\":null,\"raw\":\"The Magos\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"kind\":\"zbiór/powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":141,\"readerTitle\":\"The Magos\"},{\"id\":\"b0143\",\"title\":\"Eisenhorn: The Omnibus\",\"pl\":\"Omnibus – Eisenhorn\",\"series\":\"EISENHORN / RAVENOR / BEQUIN\",\"number\":null,\"raw\":\"Eisenhorn: The Omnibus · Eisenhorn: The Omnibus (PL: Omnibus – Eisenhorn)\",\"uncertain\":true,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Xenos\",\"Malleus\",\"Hereticus\",\"The Magos\"],\"readerOffset\":142,\"readerTitle\":\"Eisenhorn: The Omnibus\"},{\"id\":\"b0144\",\"title\":\"Ravenor\",\"pl\":null,\"series\":\"EISENHORN / RAVENOR / BEQUIN\",\"number\":null,\"raw\":\"Ravenor\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Ravenor: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Ravenor: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":143,\"readerTitle\":\"Ravenor\"},{\"id\":\"b0145\",\"title\":\"Ravenor Returned\",\"pl\":null,\"series\":\"EISENHORN / RAVENOR / BEQUIN\",\"number\":null,\"raw\":\"Ravenor Returned\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Ravenor: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Ravenor: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":144,\"readerTitle\":\"Ravenor Returned\"},{\"id\":\"b0146\",\"title\":\"Ravenor Rogue\",\"pl\":null,\"series\":\"EISENHORN / RAVENOR / BEQUIN\",\"number\":null,\"raw\":\"Ravenor Rogue\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Ravenor: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Ravenor: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":145,\"readerTitle\":\"Ravenor Rogue\"},{\"id\":\"b0147\",\"title\":\"Pariah (Ravenor vs. Eisenhorn)\",\"pl\":null,\"series\":\"EISENHORN / RAVENOR / BEQUIN\",\"number\":null,\"raw\":\"Pariah (Ravenor vs. Eisenhorn)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":146,\"readerTitle\":\"Pariah\"},{\"id\":\"b0148\",\"title\":\"Penitent\",\"pl\":null,\"series\":\"EISENHORN / RAVENOR / BEQUIN\",\"number\":null,\"raw\":\"Penitent\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":147,\"readerTitle\":\"Penitent\"},{\"id\":\"b0149\",\"title\":\"For the Emperor\",\"pl\":null,\"series\":\"CIAPHAS CAIN\",\"number\":null,\"raw\":\"For the Emperor\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Ciaphas Cain: Hero of the Imperium\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Ciaphas Cain: Hero of the Imperium\"],\"catalogMarker\":\"P\",\"readerOffset\":148,\"readerTitle\":\"For the Emperor\"},{\"id\":\"b0150\",\"title\":\"Caves of Ice\",\"pl\":null,\"series\":\"CIAPHAS CAIN\",\"number\":null,\"raw\":\"Caves of Ice\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Ciaphas Cain: Hero of the Imperium\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Ciaphas Cain: Hero of the Imperium\"],\"catalogMarker\":\"P\",\"readerOffset\":149,\"readerTitle\":\"Caves of Ice\"},{\"id\":\"b0151\",\"title\":\"The Traitor's Hand\",\"pl\":null,\"series\":\"CIAPHAS CAIN\",\"number\":null,\"raw\":\"The Traitor's Hand\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Ciaphas Cain: Hero of the Imperium\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Ciaphas Cain: Hero of the Imperium\"],\"catalogMarker\":\"P\",\"readerOffset\":150,\"readerTitle\":\"The Traitor's Hand\"},{\"id\":\"b0152\",\"title\":\"Death or Glory\",\"pl\":null,\"series\":\"CIAPHAS CAIN\",\"number\":null,\"raw\":\"Death or Glory\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Ciaphas Cain: Defender of the Imperium\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Ciaphas Cain: Defender of the Imperium\"],\"catalogMarker\":\"P\",\"readerOffset\":151,\"readerTitle\":\"Death or Glory\"},{\"id\":\"b0153\",\"title\":\"Duty Calls\",\"pl\":null,\"series\":\"CIAPHAS CAIN\",\"number\":null,\"raw\":\"Duty Calls\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Ciaphas Cain: Defender of the Imperium\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Ciaphas Cain: Defender of the Imperium\"],\"catalogMarker\":\"P\",\"readerOffset\":152,\"readerTitle\":\"Duty Calls\"},{\"id\":\"b0154\",\"title\":\"Cain's Last Stand\",\"pl\":null,\"series\":\"CIAPHAS CAIN\",\"number\":null,\"raw\":\"Cain's Last Stand\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Ciaphas Cain: Defender of the Imperium\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Ciaphas Cain: Defender of the Imperium\"],\"catalogMarker\":\"P\",\"readerOffset\":153,\"readerTitle\":\"Cain's Last Stand\"},{\"id\":\"b0155\",\"title\":\"The Emperor's Finest\",\"pl\":null,\"series\":\"CIAPHAS CAIN\",\"number\":null,\"raw\":\"The Emperor's Finest\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Ciaphas Cain: Saviour of the Imperium\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Ciaphas Cain: Saviour of the Imperium\"],\"catalogMarker\":\"P\",\"readerOffset\":154,\"readerTitle\":\"The Emperor's Finest\"},{\"id\":\"b0156\",\"title\":\"The Last Ditch\",\"pl\":null,\"series\":\"CIAPHAS CAIN\",\"number\":null,\"raw\":\"The Last Ditch\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Ciaphas Cain: Saviour of the Imperium\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Ciaphas Cain: Saviour of the Imperium\"],\"catalogMarker\":\"P\",\"readerOffset\":155,\"readerTitle\":\"The Last Ditch\"},{\"id\":\"b0157\",\"title\":\"The Greater Good\",\"pl\":null,\"series\":\"CIAPHAS CAIN\",\"number\":null,\"raw\":\"The Greater Good\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Ciaphas Cain: Saviour of the Imperium\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Ciaphas Cain: Saviour of the Imperium\"],\"catalogMarker\":\"P\",\"readerOffset\":156,\"readerTitle\":\"The Greater Good\"},{\"id\":\"b0158\",\"title\":\"Choose Your Enemies\",\"pl\":null,\"series\":\"CIAPHAS CAIN\",\"number\":null,\"raw\":\"Choose Your Enemies\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":157,\"readerTitle\":\"Choose Your Enemies\"},{\"id\":\"b0159\",\"title\":\"Vainglorious\",\"pl\":null,\"series\":\"CIAPHAS CAIN\",\"number\":null,\"raw\":\"Vainglorious\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":158,\"readerTitle\":\"Vainglorious\"},{\"id\":\"b0160\",\"title\":\"Old Soldiers Never Die\",\"pl\":null,\"series\":\"CIAPHAS CAIN\",\"number\":null,\"raw\":\"Old Soldiers Never Die · Old Soldiers Never Die (nowela)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"kind\":\"nowela\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":159,\"readerTitle\":\"Old Soldiers Never Die\"},{\"id\":\"b0161\",\"title\":\"Scourge the Heretic\",\"pl\":null,\"series\":\"DARK HERESY / INKWIZYCJA\",\"number\":null,\"raw\":\"Scourge the Heretic\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. UWAGA: BŁĘDNA SEKCJA W ŹRÓDLE: Dark Heresy / Inquisitor Roth, nie Ciaphas Cain.\",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":160,\"readerTitle\":\"Scourge the Heretic\"},{\"id\":\"b0162\",\"title\":\"Innocence Proves Nothing\",\"pl\":null,\"series\":\"DARK HERESY / INKWIZYCJA\",\"number\":null,\"raw\":\"Innocence Proves Nothing\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. UWAGA: BŁĘDNA SEKCJA W ŹRÓDLE: Dark Heresy / Inquisitor Roth, nie Ciaphas Cain.\",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":161,\"readerTitle\":\"Innocence Proves Nothing\"},{\"id\":\"b0163\",\"title\":\"Imperial Creed\",\"pl\":null,\"series\":\"YARRICK\",\"number\":null,\"raw\":\"Imperial Creed\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":162,\"readerTitle\":\"Imperial Creed\"},{\"id\":\"b0164\",\"title\":\"The Pyres of Armageddon\",\"pl\":null,\"series\":\"YARRICK\",\"number\":null,\"raw\":\"The Pyres of Armageddon\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":163,\"readerTitle\":\"The Pyres of Armageddon\"},{\"id\":\"b0165\",\"title\":\"Chains of Golgotha\",\"pl\":null,\"series\":\"YARRICK\",\"number\":null,\"raw\":\"Chains of Golgotha · Chains of Golgotha (nowela)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"kind\":\"nowela\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":164,\"readerTitle\":\"Chains of Golgotha\"},{\"id\":\"b0166\",\"title\":\"Yarrick: The Omnibus\",\"pl\":null,\"series\":\"YARRICK\",\"number\":null,\"raw\":\"Yarrick: The Omnibus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. \\nUzupełniona mapa powieści i nowel w zbiorze. Nie wszystkie utwory mają osobny wpis w katalogu. Źródło: https://www.blacklibrary.com/all-products/yarrick-the-omnibus-ebook.html\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Imperial Creed\",\"The Pyres of Armageddon\",\"Chains of Golgotha\"],\"readerOffset\":165,\"readerTitle\":\"Yarrick: The Omnibus\"},{\"id\":\"b0167\",\"title\":\"Dark Imperium\",\"pl\":\"Mroczne Imperium\",\"series\":\"DARK IMPERIUM (TRYLOGIA)\",\"number\":null,\"raw\":\"Dark Imperium · Dark Imperium (PL: Mroczne Imperium)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":166,\"readerTitle\":\"Dark Imperium\"},{\"id\":\"b0168\",\"title\":\"Plague War\",\"pl\":\"Mroczne Imperium: Wojna z Zarazą\",\"series\":\"DARK IMPERIUM (TRYLOGIA)\",\"number\":null,\"raw\":\"Plague War · Plague War (PL: Mroczne Imperium: Wojna z Zarazą)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":167,\"readerTitle\":\"Plague War\"},{\"id\":\"b0169\",\"title\":\"Godblight\",\"pl\":\"Mroczne Imperium: Boska Śnieć\",\"series\":\"DARK IMPERIUM (TRYLOGIA)\",\"number\":null,\"raw\":\"Godblight · Godblight (PL: Mroczne Imperium: Boska Śnieć – tak w źródle, możliwa literówka)\",\"uncertain\":true,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":168,\"readerTitle\":\"Godblight\"},{\"id\":\"b0170\",\"title\":\"Avenging Son\",\"pl\":\"Mściwy Syn\",\"series\":\"DAWN OF FIRE\",\"number\":1,\"raw\":\"Avenging Son · Avenging Son (PL: Mściwy Syn)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":169,\"readerTitle\":\"Avenging Son\"},{\"id\":\"b0171\",\"title\":\"The Gate of Bones\",\"pl\":\"Brama z Kości\",\"series\":\"DAWN OF FIRE\",\"number\":2,\"raw\":\"The Gate of Bones · The Gate of Bones (PL: Brama z Kości)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":170,\"readerTitle\":\"The Gate of Bones\"},{\"id\":\"b0172\",\"title\":\"The Wolftime\",\"pl\":\"Czas Wilka\",\"series\":\"DAWN OF FIRE\",\"number\":3,\"raw\":\"The Wolftime · The Wolftime (PL: Czas Wilka)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":171,\"readerTitle\":\"The Wolftime\"},{\"id\":\"b0173\",\"title\":\"Throne of Light\",\"pl\":\"Świetlisty Tron\",\"series\":\"DAWN OF FIRE\",\"number\":4,\"raw\":\"Throne of Light · Throne of Light (PL: Świetlisty Tron)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":172,\"readerTitle\":\"Throne of Light\"},{\"id\":\"b0174\",\"title\":\"The Iron Kingdom\",\"pl\":\"Żelazne Królestwo\",\"series\":\"DAWN OF FIRE\",\"number\":5,\"raw\":\"The Iron Kingdom · The Iron Kingdom (PL: Żelazne Królestwo)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":173,\"readerTitle\":\"The Iron Kingdom\"},{\"id\":\"b0175\",\"title\":\"The Martyr's Tomb\",\"pl\":null,\"series\":\"DAWN OF FIRE\",\"number\":6,\"raw\":\"The Martyr's Tomb\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":174,\"readerTitle\":\"The Martyr's Tomb\"},{\"id\":\"b0176\",\"title\":\"Sea of Souls\",\"pl\":null,\"series\":\"DAWN OF FIRE\",\"number\":7,\"raw\":\"Sea of Souls\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":175,\"readerTitle\":\"Sea of Souls\"},{\"id\":\"b0177\",\"title\":\"Hand of Abaddon\",\"pl\":null,\"series\":\"DAWN OF FIRE\",\"number\":8,\"raw\":\"Hand of Abaddon\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":176,\"readerTitle\":\"Hand of Abaddon\"},{\"id\":\"b0178\",\"title\":\"The Silent King\",\"pl\":null,\"series\":\"DAWN OF FIRE\",\"number\":9,\"raw\":\"The Silent King\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":177,\"readerTitle\":\"The Silent King\"},{\"id\":\"b0179\",\"title\":\"Rynn's World\",\"pl\":\"Świat Rynn\",\"series\":\"SPACE MARINE BATTLES\",\"number\":1,\"raw\":\"Rynn's World · Rynn's World (PL: Świat Rynn)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The War for Rynn’s World\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The War for Rynn’s World\"],\"catalogMarker\":\"P\",\"readerOffset\":178,\"readerTitle\":\"Rynn's World\"},{\"id\":\"b0180\",\"title\":\"Helsreach\",\"pl\":\"Helsreach\",\"series\":\"SPACE MARINE BATTLES\",\"number\":2,\"raw\":\"Helsreach · Helsreach (PL: Helsreach)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Armageddon\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Armageddon\"],\"catalogMarker\":\"P\",\"readerOffset\":179,\"readerTitle\":\"Helsreach\"},{\"id\":\"b0181\",\"title\":\"The Hunt for Voldorius\",\"pl\":\"Polowanie na Voldoriusa\",\"series\":\"SPACE MARINE BATTLES\",\"number\":3,\"raw\":\"The Hunt for Voldorius · The Hunt for Voldorius (PL: Polowanie na Voldoriusa)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":180,\"readerTitle\":\"The Hunt for Voldorius\"},{\"id\":\"b0182\",\"title\":\"The Purging of Kadillus\",\"pl\":\"Oczyszczenie Kadillusa\",\"series\":\"SPACE MARINE BATTLES\",\"number\":4,\"raw\":\"The Purging of Kadillus · The Purging of Kadillus (PL: Oczyszczenie Kadillusa)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Knights of Caliban\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Knights of Caliban\"],\"catalogMarker\":\"P\",\"readerOffset\":181,\"readerTitle\":\"The Purging of Kadillus\"},{\"id\":\"b0183\",\"title\":\"The Fall of Damnos\",\"pl\":\"Upadek Damnosa\",\"series\":\"SPACE MARINE BATTLES\",\"number\":5,\"raw\":\"The Fall of Damnos · The Fall of Damnos (PL: Upadek Damnosa)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":182,\"readerTitle\":\"The Fall of Damnos\"},{\"id\":\"b0184\",\"title\":\"Battle of the Fang\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":6,\"raw\":\"Battle of the Fang\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: War of the Fang\",\"kind\":\"powieść\",\"omnibusTitles\":[\"War of the Fang\"],\"catalogMarker\":\"P\",\"readerOffset\":183,\"readerTitle\":\"Battle of the Fang\"},{\"id\":\"b0185\",\"title\":\"The Gildar Rift\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":7,\"raw\":\"The Gildar Rift\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":184,\"readerTitle\":\"The Gildar Rift\"},{\"id\":\"b0186\",\"title\":\"Catechism of Hate\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":8,\"raw\":\"Catechism of Hate · Catechism of Hate (nowela)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"kind\":\"nowela\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":185,\"readerTitle\":\"Catechism of Hate\"},{\"id\":\"b0187\",\"title\":\"Legion of the Damned\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":9,\"raw\":\"Legion of the Damned\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":186,\"readerTitle\":\"Legion of the Damned\"},{\"id\":\"b0188\",\"title\":\"Architect of Fate\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":10,\"raw\":\"Architect of Fate · Architect of Fate (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":187,\"readerTitle\":\"Architect of Fate\"},{\"id\":\"b0189\",\"title\":\"Wrath of Iron\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":11,\"raw\":\"Wrath of Iron\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":188,\"readerTitle\":\"Wrath of Iron\"},{\"id\":\"b0190\",\"title\":\"The Siege of Castellax\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":12,\"raw\":\"The Siege of Castellax\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":189,\"readerTitle\":\"The Siege of Castellax\"},{\"id\":\"b0191\",\"title\":\"The Death of Antagonis\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":13,\"raw\":\"The Death of Antagonis\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":190,\"readerTitle\":\"The Death of Antagonis\"},{\"id\":\"b0192\",\"title\":\"The Death of Integrity\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":14,\"raw\":\"The Death of Integrity\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":191,\"readerTitle\":\"The Death of Integrity\"},{\"id\":\"b0193\",\"title\":\"Malodrax\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":15,\"raw\":\"Malodrax\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":192,\"readerTitle\":\"Malodrax\"},{\"id\":\"b0194\",\"title\":\"Overfiend\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":16,\"raw\":\"Overfiend · Overfiend (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":193,\"readerTitle\":\"Overfiend\"},{\"id\":\"b0195\",\"title\":\"Pandorax\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":17,\"raw\":\"Pandorax\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":194,\"readerTitle\":\"Pandorax\"},{\"id\":\"b0196\",\"title\":\"Damocles\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":18,\"raw\":\"Damocles · Damocles (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":195,\"readerTitle\":\"Damocles\"},{\"id\":\"b0197\",\"title\":\"The World Engine\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":19,\"raw\":\"The World Engine\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":196,\"readerTitle\":\"The World Engine\"},{\"id\":\"b0198\",\"title\":\"Sanctus Reach\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":20,\"raw\":\"Sanctus Reach · Sanctus Reach (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":197,\"readerTitle\":\"Sanctus Reach\"},{\"id\":\"b0199\",\"title\":\"Flesh Tearers\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":21,\"raw\":\"Flesh Tearers · Flesh Tearers (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":198,\"readerTitle\":\"Flesh Tearers\"},{\"id\":\"b0200\",\"title\":\"Blades of Damocles\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":22,\"raw\":\"Blades of Damocles\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":199,\"readerTitle\":\"Blades of Damocles\"},{\"id\":\"b0201\",\"title\":\"The Plagues of Orath\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":23,\"raw\":\"The Plagues of Orath · The Plagues of Orath (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":200,\"readerTitle\":\"The Plagues of Orath\"},{\"id\":\"b0202\",\"title\":\"Crusaders of Dorn\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":24,\"raw\":\"Crusaders of Dorn\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":201,\"readerTitle\":\"Crusaders of Dorn\"},{\"id\":\"b0203\",\"title\":\"Calgar's Siege\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":25,\"raw\":\"Calgar's Siege\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":202,\"readerTitle\":\"Calgar's Siege\"},{\"id\":\"b0204\",\"title\":\"Storm of Damocles\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":26,\"raw\":\"Storm of Damocles\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":203,\"readerTitle\":\"Storm of Damocles\"},{\"id\":\"b0205\",\"title\":\"Tyrant of the Hollow Worlds\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":27,\"raw\":\"Tyrant of the Hollow Worlds\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":204,\"readerTitle\":\"Tyrant of the Hollow Worlds\"},{\"id\":\"b0206\",\"title\":\"Shield of Baal\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":28,\"raw\":\"Shield of Baal · Shield of Baal (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":205,\"readerTitle\":\"Shield of Baal\"},{\"id\":\"b0207\",\"title\":\"Scythes of the Emperor\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":29,\"raw\":\"Scythes of the Emperor\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":206,\"readerTitle\":\"Scythes of the Emperor\"},{\"id\":\"b0208\",\"title\":\"The Eye of Ezekiel\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":30,\"raw\":\"The Eye of Ezekiel\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":207,\"readerTitle\":\"The Eye of Ezekiel\"},{\"id\":\"b0209\",\"title\":\"Armageddon\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":null,\"raw\":\"Armageddon · Armageddon (omnibus: Helsreach + Blood and Fire)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Helsreach\",\"Blood and Fire\"],\"readerOffset\":208,\"readerTitle\":\"Armageddon\"},{\"id\":\"b0210\",\"title\":\"Damnos\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":null,\"raw\":\"Damnos · Damnos (omnibus)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \\nUzupełniona mapa powieści i nowel w zbiorze. Nie wszystkie utwory mają osobny wpis w katalogu. Źródło: https://www.blacklibrary.com/all-products/damnos-ebook.html\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"The Fall of Damnos\",\"Spear of Macragge\"],\"readerOffset\":209,\"readerTitle\":\"Damnos\"},{\"id\":\"b0211\",\"title\":\"The War for Rynn's World\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":null,\"raw\":\"The War for Rynn's World · The War for Rynn's World (omnibus)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \\nUzupełniona mapa powieści i nowel w zbiorze. Nie wszystkie utwory mają osobny wpis w katalogu. Źródło: https://wh40k.lexicanum.com/wiki/The_War_for_Rynn%27s_World_%28Omnibus%29\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Rynn's World\",\"Traitor's Gorge\"],\"readerOffset\":210,\"readerTitle\":\"The War for Rynn's World\"},{\"id\":\"b0212\",\"title\":\"War of the Fang\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":null,\"raw\":\"War of the Fang · War of the Fang (omnibus)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \\nUzupełniona mapa powieści i nowel w zbiorze. Nie wszystkie utwory mają osobny wpis w katalogu. Źródło: https://www.blacklibrary.com/series/space-marine-battles/war-of-the-fang-ebook.html\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Battle of the Fang\",\"Hunt for Magnus\"],\"readerOffset\":211,\"readerTitle\":\"War of the Fang\"},{\"id\":\"b0213\",\"title\":\"Defenders of Mankind\",\"pl\":null,\"series\":\"SPACE MARINE BATTLES\",\"number\":null,\"raw\":\"Defenders of Mankind · Defenders of Mankind (omnibus)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \\nUzupełniona mapa powieści i nowel w zbiorze. Nie wszystkie utwory mają osobny wpis w katalogu. Źródło: https://www.blacklibrary.com/authors/anthologies/defenders-of-mankind-omnibus-ebook.html\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"The Death of Antagonis\",\"Death of Integrity\"],\"readerOffset\":212,\"readerTitle\":\"Defenders of Mankind\"},{\"id\":\"b0214\",\"title\":\"The Devastation of Baal\",\"pl\":null,\"series\":\"SPACE MARINE CONQUESTS\",\"number\":1,\"raw\":\"The Devastation of Baal\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":213,\"readerTitle\":\"The Devastation of Baal\"},{\"id\":\"b0215\",\"title\":\"Ashes of Prospero\",\"pl\":null,\"series\":\"SPACE MARINE CONQUESTS\",\"number\":2,\"raw\":\"Ashes of Prospero\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":214,\"readerTitle\":\"Ashes of Prospero\"},{\"id\":\"b0216\",\"title\":\"War of Secrets\",\"pl\":null,\"series\":\"SPACE MARINE CONQUESTS\",\"number\":3,\"raw\":\"War of Secrets\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":215,\"readerTitle\":\"War of Secrets\"},{\"id\":\"b0217\",\"title\":\"Of Honour and Iron\",\"pl\":null,\"series\":\"SPACE MARINE CONQUESTS\",\"number\":4,\"raw\":\"Of Honour and Iron\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":216,\"readerTitle\":\"Of Honour and Iron\"},{\"id\":\"b0218\",\"title\":\"Apocalypse\",\"pl\":null,\"series\":\"SPACE MARINE CONQUESTS\",\"number\":5,\"raw\":\"Apocalypse\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":217,\"readerTitle\":\"Apocalypse\"},{\"id\":\"b0219\",\"title\":\"Fist of the Imperium\",\"pl\":null,\"series\":\"SPACE MARINE CONQUESTS\",\"number\":6,\"raw\":\"Fist of the Imperium\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":218,\"readerTitle\":\"Fist of the Imperium\"},{\"id\":\"b0220\",\"title\":\"For Glory and Honour\",\"pl\":null,\"series\":\"SPACE MARINE CONQUESTS\",\"number\":null,\"raw\":\"For Glory and Honour · For Glory and Honour (omnibus)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \\nUzupełniona mapa powieści i nowel w zbiorze. Nie wszystkie utwory mają osobny wpis w katalogu. Źródło: https://www.warhammer-community.com/en-gb/articles/awAsVInf/black-library-pre-orders-a-regiments-worth-of-astra-militarum-stories/\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Fist of the Imperium\",\"Apocalypse\",\"Of Honour and Iron\"],\"readerOffset\":219,\"readerTitle\":\"For Glory and Honour\"},{\"id\":\"b0221\",\"title\":\"Lemartes: Guardian of the Lost\",\"pl\":null,\"series\":\"SPACE MARINE LEGENDS\",\"number\":null,\"raw\":\"Lemartes: Guardian of the Lost\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":220,\"readerTitle\":\"Lemartes: Guardian of the Lost\"},{\"id\":\"b0222\",\"title\":\"Ragnar Blackmane\",\"pl\":null,\"series\":\"SPACE MARINE LEGENDS\",\"number\":null,\"raw\":\"Ragnar Blackmane\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":221,\"readerTitle\":\"Ragnar Blackmane\"},{\"id\":\"b0223\",\"title\":\"Cassius\",\"pl\":null,\"series\":\"SPACE MARINE LEGENDS\",\"number\":null,\"raw\":\"Cassius\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":222,\"readerTitle\":\"Cassius\"},{\"id\":\"b0224\",\"title\":\"Shrike\",\"pl\":null,\"series\":\"SPACE MARINE LEGENDS\",\"number\":null,\"raw\":\"Shrike\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":223,\"readerTitle\":\"Shrike\"},{\"id\":\"b0225\",\"title\":\"Azrael\",\"pl\":null,\"series\":\"SPACE MARINE LEGENDS\",\"number\":null,\"raw\":\"Azrael\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Knights of Caliban\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Knights of Caliban\"],\"catalogMarker\":\"P\",\"readerOffset\":224,\"readerTitle\":\"Azrael\"},{\"id\":\"b0226\",\"title\":\"Space Wolf\",\"pl\":\"Kosmiczny Wilk\",\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"Space Wolf · Space Wolf (PL: Kosmiczny Wilk)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Space Wolf Omnibus (tom 1)\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Space Wolf Omnibus (Volume 1)\"],\"catalogMarker\":\"P\",\"readerOffset\":225,\"readerTitle\":\"Space Wolf\"},{\"id\":\"b0227\",\"title\":\"Ragnar's Claw\",\"pl\":\"Szpon Ragnara\",\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"Ragnar's Claw · Ragnar's Claw (PL: Szpon Ragnara)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Space Wolf Omnibus (tom 1)\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Space Wolf Omnibus (Volume 1)\"],\"catalogMarker\":\"P\",\"readerOffset\":226,\"readerTitle\":\"Ragnar's Claw\"},{\"id\":\"b0228\",\"title\":\"Grey Hunter\",\"pl\":\"Szary Łowca\",\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"Grey Hunter · Grey Hunter (PL: Szary Łowca)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Space Wolf Omnibus (tom 1)\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Space Wolf Omnibus (Volume 1)\"],\"catalogMarker\":\"P\",\"readerOffset\":227,\"readerTitle\":\"Grey Hunter\"},{\"id\":\"b0229\",\"title\":\"Wolfblade\",\"pl\":\"Wilcze ostrza\",\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"Wolfblade · Wolfblade (PL: Wilcze ostrza)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Space Wolf Omnibus (tom 2)\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Space Wolf Omnibus (Volume 2)\"],\"catalogMarker\":\"P\",\"readerOffset\":228,\"readerTitle\":\"Wolfblade\"},{\"id\":\"b0230\",\"title\":\"Sons of Fenris\",\"pl\":\"Synowie Fenrisa\",\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"Sons of Fenris · Sons of Fenris (PL: Synowie Fenrisa)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Space Wolf Omnibus (tom 2)\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Space Wolf Omnibus (Volume 2)\"],\"catalogMarker\":\"P\",\"readerOffset\":229,\"readerTitle\":\"Sons of Fenris\"},{\"id\":\"b0231\",\"title\":\"Wolf's Honour\",\"pl\":\"Honor Wilka\",\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"Wolf's Honour · Wolf's Honour (PL: Honor Wilka)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Space Wolf Omnibus (tom 2)\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Space Wolf Omnibus (Volume 2)\"],\"catalogMarker\":\"P\",\"readerOffset\":230,\"readerTitle\":\"Wolf's Honour\"},{\"id\":\"b0232\",\"title\":\"The Space Wolf Omnibus\",\"pl\":null,\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"The Space Wolf Omnibus\",\"uncertain\":true,\"note\":\"Źródło: katalog papierowy z 12.10.2026. UWAGA: Tytuł niejednoznaczny: są różne omnibusy Space Wolf; należy rozróżnić wydania.\\nUzupełniona mapa powieści i nowel w zbiorze. Nie wszystkie utwory mają osobny wpis w katalogu. Źródło: https://www.blacklibrary.com/warhammer-40000/novels/space-wolf-trilogy.html\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Space Wolf\",\"Ragnar’s Claw\",\"Grey Hunter\"],\"readerOffset\":231,\"readerTitle\":\"The Space Wolf Omnibus\"},{\"id\":\"b0233\",\"title\":\"Blood of Asaheim\",\"pl\":null,\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"Blood of Asaheim\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":232,\"readerTitle\":\"Blood of Asaheim\"},{\"id\":\"b0234\",\"title\":\"Stormcaller\",\"pl\":null,\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"Stormcaller\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":233,\"readerTitle\":\"Stormcaller\"},{\"id\":\"b0235\",\"title\":\"The Helwinter Gate\",\"pl\":null,\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"The Helwinter Gate\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":234,\"readerTitle\":\"The Helwinter Gate\"},{\"id\":\"b0236\",\"title\":\"Curse of the Wulfen\",\"pl\":null,\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"Curse of the Wulfen\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":235,\"readerTitle\":\"Curse of the Wulfen\"},{\"id\":\"b0237\",\"title\":\"Lukas the Trickster\",\"pl\":null,\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"Lukas the Trickster\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":236,\"readerTitle\":\"Lukas the Trickster\"},{\"id\":\"b0238\",\"title\":\"Krakenblood\",\"pl\":null,\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"Krakenblood\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":237,\"readerTitle\":\"Krakenblood\"},{\"id\":\"b0239\",\"title\":\"Bjorn: The Fell-Handed\",\"pl\":null,\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"Bjorn: The Fell-Handed\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":238,\"readerTitle\":\"Bjorn: The Fell-Handed\"},{\"id\":\"b0240\",\"title\":\"Sons of Russ\",\"pl\":null,\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"Sons of Russ · Sons of Russ (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":239,\"readerTitle\":\"Sons of Russ\"},{\"id\":\"b0241\",\"title\":\"Wolves of Fenris\",\"pl\":null,\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"Wolves of Fenris · Wolves of Fenris (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":240,\"readerTitle\":\"Wolves of Fenris\"},{\"id\":\"b0242\",\"title\":\"Legacy of the Wulfen\",\"pl\":null,\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"Legacy of the Wulfen · Legacy of the Wulfen (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":241,\"readerTitle\":\"Legacy of the Wulfen\"},{\"id\":\"b0243\",\"title\":\"Nightbringer\",\"pl\":\"Zwiastun Nocy\",\"series\":\"ULTRAMARINES\",\"number\":null,\"raw\":\"Nightbringer · Nightbringer (PL: Zwiastun Nocy)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Ultramarines Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Ultramarines Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":242,\"readerTitle\":\"Nightbringer\"},{\"id\":\"b0244\",\"title\":\"Warriors of Ultramar\",\"pl\":null,\"series\":\"ULTRAMARINES\",\"number\":null,\"raw\":\"Warriors of Ultramar\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Ultramarines Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Ultramarines Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":243,\"readerTitle\":\"Warriors of Ultramar\"},{\"id\":\"b0245\",\"title\":\"Dead Sky, Black Sun\",\"pl\":null,\"series\":\"ULTRAMARINES\",\"number\":null,\"raw\":\"Dead Sky, Black Sun\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Ultramarines Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Ultramarines Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":244,\"readerTitle\":\"Dead Sky, Black Sun\"},{\"id\":\"b0246\",\"title\":\"The Killing Ground\",\"pl\":null,\"series\":\"ULTRAMARINES\",\"number\":null,\"raw\":\"The Killing Ground\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Ultramarines Omnibus 2\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Ultramarines Omnibus 2\"],\"catalogMarker\":\"P\",\"readerOffset\":245,\"readerTitle\":\"The Killing Ground\"},{\"id\":\"b0247\",\"title\":\"Courage and Honour\",\"pl\":null,\"series\":\"ULTRAMARINES\",\"number\":null,\"raw\":\"Courage and Honour\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Ultramarines Omnibus 2\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Ultramarines Omnibus 2\"],\"catalogMarker\":\"P\",\"readerOffset\":246,\"readerTitle\":\"Courage and Honour\"},{\"id\":\"b0248\",\"title\":\"The Chapter's Due\",\"pl\":null,\"series\":\"ULTRAMARINES\",\"number\":null,\"raw\":\"The Chapter's Due\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Ultramarines Omnibus 2\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Ultramarines Omnibus 2\"],\"catalogMarker\":\"P\",\"readerOffset\":247,\"readerTitle\":\"The Chapter's Due\"},{\"id\":\"b0249\",\"title\":\"The Swords of Calth\",\"pl\":null,\"series\":\"ULTRAMARINES\",\"number\":null,\"raw\":\"The Swords of Calth\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":248,\"readerTitle\":\"The Swords of Calth\"},{\"id\":\"b0250\",\"title\":\"Calgar's Fury\",\"pl\":null,\"series\":\"ULTRAMARINES\",\"number\":null,\"raw\":\"Calgar's Fury\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":249,\"readerTitle\":\"Calgar's Fury\"},{\"id\":\"b0251\",\"title\":\"Blood of Iax\",\"pl\":null,\"series\":\"ULTRAMARINES\",\"number\":null,\"raw\":\"Blood of Iax\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":250,\"readerTitle\":\"Blood of Iax\"},{\"id\":\"b0252\",\"title\":\"Knights of Macragge\",\"pl\":null,\"series\":\"ULTRAMARINES\",\"number\":null,\"raw\":\"Knights of Macragge\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":251,\"readerTitle\":\"Knights of Macragge\"},{\"id\":\"b0253\",\"title\":\"Indomitus\",\"pl\":\"Indomitus\",\"series\":\"ULTRAMARINES\",\"number\":null,\"raw\":\"Indomitus · Indomitus (PL: Indomitus)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":252,\"readerTitle\":\"Indomitus\"},{\"id\":\"b0254\",\"title\":\"Leviathan\",\"pl\":\"Lewiatan\",\"series\":\"ULTRAMARINES\",\"number\":null,\"raw\":\"Leviathan · Leviathan (PL: Lewiatan)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":253,\"readerTitle\":\"Leviathan\"},{\"id\":\"b0255\",\"title\":\"Master of Rites\",\"pl\":null,\"series\":\"ULTRAMARINES\",\"number\":null,\"raw\":\"Master of Rites\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":254,\"readerTitle\":\"Master of Rites\"},{\"id\":\"b0256\",\"title\":\"Angels of Darkness\",\"pl\":null,\"series\":\"DARK ANGELS\",\"number\":null,\"raw\":\"Angels of Darkness\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Knights of Caliban\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Knights of Caliban\"],\"catalogMarker\":\"P\",\"readerOffset\":255,\"readerTitle\":\"Angels of Darkness\"},{\"id\":\"b0257\",\"title\":\"Ravenwing\",\"pl\":null,\"series\":\"DARK ANGELS\",\"number\":null,\"raw\":\"Ravenwing\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Legacy of Caliban\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Legacy of Caliban\"],\"catalogMarker\":\"P\",\"readerOffset\":256,\"readerTitle\":\"Ravenwing\"},{\"id\":\"b0258\",\"title\":\"Master of Sanctity\",\"pl\":null,\"series\":\"DARK ANGELS\",\"number\":null,\"raw\":\"Master of Sanctity\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Legacy of Caliban\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Legacy of Caliban\"],\"catalogMarker\":\"P\",\"readerOffset\":257,\"readerTitle\":\"Master of Sanctity\"},{\"id\":\"b0259\",\"title\":\"The Unforgiven\",\"pl\":null,\"series\":\"DARK ANGELS\",\"number\":null,\"raw\":\"The Unforgiven\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Legacy of Caliban\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Legacy of Caliban\"],\"catalogMarker\":\"P\",\"readerOffset\":258,\"readerTitle\":\"The Unforgiven\"},{\"id\":\"b0260\",\"title\":\"Lords of Caliban\",\"pl\":null,\"series\":\"DARK ANGELS\",\"number\":null,\"raw\":\"Lords of Caliban · Lords of Caliban (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":259,\"readerTitle\":\"Lords of Caliban\"},{\"id\":\"b0261\",\"title\":\"The Book of the Lion\",\"pl\":null,\"series\":\"DARK ANGELS\",\"number\":null,\"raw\":\"The Book of the Lion · The Book of the Lion (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":260,\"readerTitle\":\"The Book of the Lion\"},{\"id\":\"b0262\",\"title\":\"Knights of Caliban\",\"pl\":null,\"series\":\"DARK ANGELS\",\"number\":null,\"raw\":\"Knights of Caliban · Knights of Caliban (omnibus: Purging of Kadillus, Angels of Darkness, Azrael)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"The Purging of Kadillus\",\"Angels of Darkness\",\"Azrael\"],\"readerOffset\":261,\"readerTitle\":\"Knights of Caliban\"},{\"id\":\"b0263\",\"title\":\"The Lion: Son of the Forest\",\"pl\":\"Lion Syn Puszczy\",\"series\":\"DARK ANGELS\",\"number\":null,\"raw\":\"The Lion: Son of the Forest · The Lion: Son of the Forest (PL: Lion Syn Puszczy)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":262,\"readerTitle\":\"The Lion: Son of the Forest\"},{\"id\":\"b0264\",\"title\":\"Cypher: Lord of the Fallen\",\"pl\":null,\"series\":\"DARK ANGELS\",\"number\":null,\"raw\":\"Cypher: Lord of the Fallen\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":263,\"readerTitle\":\"Cypher: Lord of the Fallen\"},{\"id\":\"b0265\",\"title\":\"Lazarus: Enmity's Edge\",\"pl\":null,\"series\":\"DARK ANGELS\",\"number\":null,\"raw\":\"Lazarus: Enmity's Edge\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":264,\"readerTitle\":\"Lazarus: Enmity's Edge\"},{\"id\":\"b0266\",\"title\":\"Deus Encarmine\",\"pl\":null,\"series\":\"BLOOD ANGELS\",\"number\":null,\"raw\":\"Deus Encarmine\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Blood Angels: The Complete Rafen Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Blood Angels: The Complete Rafen Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":265,\"readerTitle\":\"Deus Encarmine\"},{\"id\":\"b0267\",\"title\":\"Deus Sanguinius\",\"pl\":null,\"series\":\"BLOOD ANGELS\",\"number\":null,\"raw\":\"Deus Sanguinius\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Blood Angels: The Complete Rafen Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Blood Angels: The Complete Rafen Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":266,\"readerTitle\":\"Deus Sanguinius\"},{\"id\":\"b0268\",\"title\":\"Red Fury\",\"pl\":null,\"series\":\"BLOOD ANGELS\",\"number\":null,\"raw\":\"Red Fury\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Blood Angels: The Complete Rafen Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Blood Angels: The Complete Rafen Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":267,\"readerTitle\":\"Red Fury\"},{\"id\":\"b0269\",\"title\":\"Black Tide\",\"pl\":null,\"series\":\"BLOOD ANGELS\",\"number\":null,\"raw\":\"Black Tide\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Blood Angels: The Complete Rafen Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Blood Angels: The Complete Rafen Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":268,\"readerTitle\":\"Black Tide\"},{\"id\":\"b0270\",\"title\":\"Blood Angels: The Complete Rafen Omnibus\",\"pl\":null,\"series\":\"BLOOD ANGELS\",\"number\":null,\"raw\":\"Blood Angels: The Complete Rafen Omnibus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Deus Encarmine\",\"Deus Sanguinius\",\"Red Fury\",\"Black Tide\"],\"readerOffset\":269,\"readerTitle\":\"Blood Angels: The Complete Rafen Omnibus\"},{\"id\":\"b0271\",\"title\":\"Dante\",\"pl\":null,\"series\":\"BLOOD ANGELS\",\"number\":null,\"raw\":\"Dante\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":270,\"readerTitle\":\"Dante\"},{\"id\":\"b0272\",\"title\":\"Darkness in the Blood\",\"pl\":null,\"series\":\"BLOOD ANGELS\",\"number\":null,\"raw\":\"Darkness in the Blood\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":271,\"readerTitle\":\"Darkness in the Blood\"},{\"id\":\"b0273\",\"title\":\"Astorath: Angel of Mercy\",\"pl\":null,\"series\":\"BLOOD ANGELS\",\"number\":null,\"raw\":\"Astorath: Angel of Mercy\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":272,\"readerTitle\":\"Astorath: Angel of Mercy\"},{\"id\":\"b0274\",\"title\":\"Wrath of the Lost (Flesh Tearers)\",\"pl\":null,\"series\":\"BLOOD ANGELS\",\"number\":null,\"raw\":\"Wrath of the Lost (Flesh Tearers)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":273,\"readerTitle\":\"Wrath of the Lost\"},{\"id\":\"b0275\",\"title\":\"Mephiston: Blood of Sanguinius\",\"pl\":null,\"series\":\"BLOOD ANGELS\",\"number\":null,\"raw\":\"Mephiston: Blood of Sanguinius · Blood of Sanguinius\",\"uncertain\":true,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. UWAGA: Pozycja do kontroli bibliograficznej i formatu.\",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":274,\"readerTitle\":\"Blood of Sanguinius\"},{\"id\":\"b0276\",\"title\":\"Mephiston: Revenant Crusade\",\"pl\":null,\"series\":\"BLOOD ANGELS\",\"number\":null,\"raw\":\"Mephiston: Revenant Crusade · The Revenant Crusade\",\"uncertain\":true,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. UWAGA: Pozycja do kontroli bibliograficznej i formatu.\",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":275,\"readerTitle\":\"The Revenant Crusade\"},{\"id\":\"b0277\",\"title\":\"Mephiston: City of Light\",\"pl\":null,\"series\":\"BLOOD ANGELS\",\"number\":null,\"raw\":\"Mephiston: City of Light · City of Light\",\"uncertain\":true,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. UWAGA: Pozycja do kontroli bibliograficznej i formatu.\",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":276,\"readerTitle\":\"City of Light\"},{\"id\":\"b0278\",\"title\":\"Salamander\",\"pl\":null,\"series\":\"SALAMANDERS\",\"number\":null,\"raw\":\"Salamander\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":277,\"readerTitle\":\"Salamander\"},{\"id\":\"b0279\",\"title\":\"Firedrake\",\"pl\":null,\"series\":\"SALAMANDERS\",\"number\":null,\"raw\":\"Firedrake\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":278,\"readerTitle\":\"Firedrake\"},{\"id\":\"b0280\",\"title\":\"Nocturne\",\"pl\":null,\"series\":\"SALAMANDERS\",\"number\":null,\"raw\":\"Nocturne\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":279,\"readerTitle\":\"Nocturne\"},{\"id\":\"b0281\",\"title\":\"Tome of Fire\",\"pl\":null,\"series\":\"SALAMANDERS\",\"number\":null,\"raw\":\"Tome of Fire · Tome of Fire (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":280,\"readerTitle\":\"Tome of Fire\"},{\"id\":\"b0282\",\"title\":\"Lords of Nocturne\",\"pl\":null,\"series\":\"SALAMANDERS\",\"number\":null,\"raw\":\"Lords of Nocturne · Lords of Nocturne (omnibus)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \\nUzupełniona mapa powieści i nowel w zbiorze. Nie wszystkie utwory mają osobny wpis w katalogu. Źródło: https://www.blacklibrary.com/all-products/ebook-lords-of-nocturne-eng-2024.html\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Salamander\",\"Firedrake\",\"Nocturne\",\"Tome of Fire\"],\"readerOffset\":281,\"readerTitle\":\"Lords of Nocturne\"},{\"id\":\"b0283\",\"title\":\"Red Tithe (Carcharadons)\",\"pl\":null,\"series\":\"INNE ZAKONY SPACE MARINES\",\"number\":null,\"raw\":\"Red Tithe (Carcharadons)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":282,\"readerTitle\":\"Red Tithe\"},{\"id\":\"b0284\",\"title\":\"Outer Dark (Carcharadons)\",\"pl\":null,\"series\":\"INNE ZAKONY SPACE MARINES\",\"number\":null,\"raw\":\"Outer Dark (Carcharadons)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":283,\"readerTitle\":\"Outer Dark\"},{\"id\":\"b0285\",\"title\":\"Silent Hunters (Carcharadons)\",\"pl\":null,\"series\":\"INNE ZAKONY SPACE MARINES\",\"number\":null,\"raw\":\"Silent Hunters (Carcharadons)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":284,\"readerTitle\":\"Silent Hunters\"},{\"id\":\"b0286\",\"title\":\"Void Exile (Carcharadons)\",\"pl\":null,\"series\":\"INNE ZAKONY SPACE MARINES\",\"number\":null,\"raw\":\"Void Exile (Carcharadons)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":285,\"readerTitle\":\"Void Exile\"},{\"id\":\"b0287\",\"title\":\"Iron Hands (Jonathan Green)\",\"pl\":null,\"series\":\"INNE ZAKONY SPACE MARINES\",\"number\":null,\"raw\":\"Iron Hands (Jonathan Green)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":286,\"readerTitle\":\"Iron Hands\"},{\"id\":\"b0288\",\"title\":\"The Eye of Medusa\",\"pl\":null,\"series\":\"INNE ZAKONY SPACE MARINES\",\"number\":null,\"raw\":\"The Eye of Medusa\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":287,\"readerTitle\":\"The Eye of Medusa\"},{\"id\":\"b0289\",\"title\":\"The Voice of Mars\",\"pl\":null,\"series\":\"INNE ZAKONY SPACE MARINES\",\"number\":null,\"raw\":\"The Voice of Mars\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":288,\"readerTitle\":\"The Voice of Mars\"},{\"id\":\"b0290\",\"title\":\"Savage Scars (White Scars)\",\"pl\":null,\"series\":\"INNE ZAKONY SPACE MARINES\",\"number\":null,\"raw\":\"Savage Scars (White Scars)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":289,\"readerTitle\":\"Savage Scars\"},{\"id\":\"b0291\",\"title\":\"The Last Hunt\",\"pl\":null,\"series\":\"INNE ZAKONY SPACE MARINES\",\"number\":null,\"raw\":\"The Last Hunt\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":290,\"readerTitle\":\"The Last Hunt\"},{\"id\":\"b0292\",\"title\":\"Crusade for Armageddon (Black Templars)\",\"pl\":null,\"series\":\"INNE ZAKONY SPACE MARINES\",\"number\":null,\"raw\":\"Crusade for Armageddon (Black Templars)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":291,\"readerTitle\":\"Crusade for Armageddon\"},{\"id\":\"b0293\",\"title\":\"Conquest of Armageddon\",\"pl\":null,\"series\":\"INNE ZAKONY SPACE MARINES\",\"number\":null,\"raw\":\"Conquest of Armageddon\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":292,\"readerTitle\":\"Conquest of Armageddon\"},{\"id\":\"b0294\",\"title\":\"Helbrecht: Knight of the Throne\",\"pl\":null,\"series\":\"INNE ZAKONY SPACE MARINES\",\"number\":null,\"raw\":\"Helbrecht: Knight of the Throne\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":293,\"readerTitle\":\"Helbrecht: Knight of the Throne\"},{\"id\":\"b0295\",\"title\":\"Broken Crusade\",\"pl\":null,\"series\":\"INNE ZAKONY SPACE MARINES\",\"number\":null,\"raw\":\"Broken Crusade\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":294,\"readerTitle\":\"Broken Crusade\"},{\"id\":\"b0296\",\"title\":\"Silver Skulls: Portents\",\"pl\":null,\"series\":\"INNE ZAKONY SPACE MARINES\",\"number\":null,\"raw\":\"Silver Skulls: Portents\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":295,\"readerTitle\":\"Silver Skulls: Portents\"},{\"id\":\"b0297\",\"title\":\"Extinction (Black Legion)\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Extinction (Black Legion)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":296,\"readerTitle\":\"Extinction\"},{\"id\":\"b0298\",\"title\":\"The Talon of Horus\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"The Talon of Horus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":297,\"readerTitle\":\"The Talon of Horus\"},{\"id\":\"b0299\",\"title\":\"Black Legion\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Black Legion\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":298,\"readerTitle\":\"Black Legion\"},{\"id\":\"b0300\",\"title\":\"Exile (Ahriman)\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Exile (Ahriman)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":299,\"readerTitle\":\"Exile\"},{\"id\":\"b0301\",\"title\":\"Ahriman: Sorcerer\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Ahriman: Sorcerer · Sorcerer\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":300,\"readerTitle\":\"Sorcerer\"},{\"id\":\"b0302\",\"title\":\"Ahriman: Unchanged\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Ahriman: Unchanged · Unchanged\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":301,\"readerTitle\":\"Unchanged\"},{\"id\":\"b0303\",\"title\":\"Ahriman: Eternal\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Ahriman: Eternal · Eternal\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":302,\"readerTitle\":\"Eternal\"},{\"id\":\"b0304\",\"title\":\"Ahriman: Undying\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Ahriman: Undying · Undying\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":303,\"readerTitle\":\"Undying\"},{\"id\":\"b0305\",\"title\":\"Huron Blackheart: Master of the Maelstrom\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Huron Blackheart: Master of the Maelstrom\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":304,\"readerTitle\":\"Huron Blackheart: Master of the Maelstrom\"},{\"id\":\"b0306\",\"title\":\"Blackheart: Claws of the Maelstrom\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Blackheart: Claws of the Maelstrom\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":305,\"readerTitle\":\"Blackheart: Claws of the Maelstrom\"},{\"id\":\"b0307\",\"title\":\"Khârn: Eater of Worlds\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Khârn: Eater of Worlds · Eater of Worlds\",\"uncertain\":true,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. UWAGA: Opowiadanie; nie traktować jako osobnej powieści.\",\"kind\":\"opowiadanie · do weryfikacji\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":306,\"readerTitle\":\"Eater of Worlds\"},{\"id\":\"b0308\",\"title\":\"Soul Hunter (Night Lords)\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Soul Hunter (Night Lords)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[\"Night Lords: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":307,\"readerTitle\":\"Soul Hunter\"},{\"id\":\"b0309\",\"title\":\"Blood Reaver\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Blood Reaver\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[\"Night Lords: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":308,\"readerTitle\":\"Blood Reaver\"},{\"id\":\"b0310\",\"title\":\"Void Stalker\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Void Stalker\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[\"Night Lords: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":309,\"readerTitle\":\"Void Stalker\"},{\"id\":\"b0311\",\"title\":\"Lord of the Night\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Lord of the Night\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":310,\"readerTitle\":\"Lord of the Night\"},{\"id\":\"b0312\",\"title\":\"Dark Apostle (Word Bearers)\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Dark Apostle (Word Bearers)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":311,\"readerTitle\":\"Dark Apostle\"},{\"id\":\"b0313\",\"title\":\"Dark Disciple\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Dark Disciple\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Word Bearers: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Word Bearers: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":312,\"readerTitle\":\"Dark Disciple\"},{\"id\":\"b0314\",\"title\":\"Dark Creed\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Dark Creed\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Word Bearers: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Word Bearers: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":313,\"readerTitle\":\"Dark Creed\"},{\"id\":\"b0315\",\"title\":\"Word Bearers: The Omnibus\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Word Bearers: The Omnibus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Dark Apostle (Word Bearers)\",\"Dark Disciple\",\"Dark Creed\"],\"readerOffset\":314,\"readerTitle\":\"Word Bearers: The Omnibus\"},{\"id\":\"b0316\",\"title\":\"Apostle\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Apostle\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":315,\"readerTitle\":\"Apostle\"},{\"id\":\"b0317\",\"title\":\"Storm of Iron (Iron Warriors)\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Storm of Iron (Iron Warriors)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":316,\"readerTitle\":\"Storm of Iron\"},{\"id\":\"b0318\",\"title\":\"Iron Warrior\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Iron Warrior · Iron Warrior (nowela)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"kind\":\"nowela\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":317,\"readerTitle\":\"Iron Warrior\"},{\"id\":\"b0319\",\"title\":\"Iron Warriors: The Omnibus\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Iron Warriors: The Omnibus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \\nUzupełniona mapa powieści i nowel w zbiorze. Nie wszystkie utwory mają osobny wpis w katalogu. Źródło: https://www.blacklibrary.com/warhammer-40000/novels/iron-warriors-omnibus-cs-2018.html\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Storm of Iron (Iron Warriors)\",\"Iron Warrior\"],\"readerOffset\":318,\"readerTitle\":\"Iron Warriors: The Omnibus\"},{\"id\":\"b0320\",\"title\":\"Soul Drinker (Soul Drinkers)\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Soul Drinker (Soul Drinkers)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":319,\"readerTitle\":\"Soul Drinker\"},{\"id\":\"b0321\",\"title\":\"The Bleeding Chalice\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"The Bleeding Chalice\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Soul Drinkers: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Soul Drinkers: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":320,\"readerTitle\":\"The Bleeding Chalice\"},{\"id\":\"b0322\",\"title\":\"Crimson Tears\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Crimson Tears\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Soul Drinkers: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Soul Drinkers: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":321,\"readerTitle\":\"Crimson Tears\"},{\"id\":\"b0323\",\"title\":\"Chapter War\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Chapter War\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Soul Drinkers: Annihilation\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Soul Drinkers: Annihilation\"],\"catalogMarker\":\"P\",\"readerOffset\":322,\"readerTitle\":\"Chapter War\"},{\"id\":\"b0324\",\"title\":\"Hellforged\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Hellforged\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Soul Drinkers: Annihilation\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Soul Drinkers: Annihilation\"],\"catalogMarker\":\"P\",\"readerOffset\":323,\"readerTitle\":\"Hellforged\"},{\"id\":\"b0325\",\"title\":\"Phalanx\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Phalanx\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Soul Drinkers: Annihilation\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Soul Drinkers: Annihilation\"],\"catalogMarker\":\"P\",\"readerOffset\":324,\"readerTitle\":\"Phalanx\"},{\"id\":\"b0326\",\"title\":\"Primogenitor (Emperor's Children)\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Primogenitor (Emperor's Children)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":325,\"readerTitle\":\"Primogenitor\"},{\"id\":\"b0327\",\"title\":\"Clonelord\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Clonelord\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":326,\"readerTitle\":\"Clonelord\"},{\"id\":\"b0328\",\"title\":\"Manflayer\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Manflayer\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":327,\"readerTitle\":\"Manflayer\"},{\"id\":\"b0329\",\"title\":\"The Faultless Blade\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"The Faultless Blade\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":328,\"readerTitle\":\"The Faultless Blade\"},{\"id\":\"b0330\",\"title\":\"Renegades: Harrowmaster\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Renegades: Harrowmaster\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":329,\"readerTitle\":\"Renegades: Harrowmaster\"},{\"id\":\"b0331\",\"title\":\"Renegades: Lord of Excess\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Renegades: Lord of Excess\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":330,\"readerTitle\":\"Renegades: Lord of Excess\"},{\"id\":\"b0332\",\"title\":\"Daemon World\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Daemon World\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":331,\"readerTitle\":\"Daemon World\"},{\"id\":\"b0333\",\"title\":\"Pawns of Chaos\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Pawns of Chaos\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":332,\"readerTitle\":\"Pawns of Chaos\"},{\"id\":\"b0334\",\"title\":\"Grey Knights\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Grey Knights\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Grey Knights: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Grey Knights: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":333,\"readerTitle\":\"Grey Knights\"},{\"id\":\"b0335\",\"title\":\"Dark Adeptus\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Dark Adeptus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Grey Knights: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Grey Knights: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":334,\"readerTitle\":\"Dark Adeptus\"},{\"id\":\"b0336\",\"title\":\"Hammer of Daemons\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Hammer of Daemons\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Grey Knights: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Grey Knights: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":335,\"readerTitle\":\"Hammer of Daemons\"},{\"id\":\"b0337\",\"title\":\"The Emperor's Gift\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"The Emperor's Gift\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":336,\"readerTitle\":\"The Emperor's Gift\"},{\"id\":\"b0338\",\"title\":\"Warden of the Blade\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Warden of the Blade\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":337,\"readerTitle\":\"Warden of the Blade\"},{\"id\":\"b0339\",\"title\":\"Castellan\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Castellan\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":338,\"readerTitle\":\"Castellan\"},{\"id\":\"b0340\",\"title\":\"Inquisitor (Inquisition War)\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Inquisitor (Inquisition War)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":339,\"readerTitle\":\"Inquisitor\"},{\"id\":\"b0341\",\"title\":\"Harlequin\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Harlequin\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":340,\"readerTitle\":\"Harlequin\"},{\"id\":\"b0342\",\"title\":\"Chaos Child\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Chaos Child\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":341,\"readerTitle\":\"Chaos Child\"},{\"id\":\"b0343\",\"title\":\"Brothers of the Snake\",\"pl\":null,\"series\":\"INNE ZAKONY SPACE MARINES\",\"number\":null,\"raw\":\"Brothers of the Snake\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":342,\"readerTitle\":\"Brothers of the Snake\"},{\"id\":\"b0344\",\"title\":\"The Carrion Throne (Wraight)\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"The Carrion Throne (Wraight)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":343,\"readerTitle\":\"The Carrion Throne\"},{\"id\":\"b0345\",\"title\":\"The Hollow Mountain\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"The Hollow Mountain\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Vaults of Terra: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Vaults of Terra: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":344,\"readerTitle\":\"The Hollow Mountain\"},{\"id\":\"b0346\",\"title\":\"The Dark City\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"The Dark City\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Vaults of Terra: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Vaults of Terra: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":345,\"readerTitle\":\"The Dark City\"},{\"id\":\"b0347\",\"title\":\"Resurrection (French)\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Resurrection (French)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":346,\"readerTitle\":\"Resurrection\"},{\"id\":\"b0348\",\"title\":\"Incarnation\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Incarnation\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":347,\"readerTitle\":\"Incarnation\"},{\"id\":\"b0349\",\"title\":\"Divination\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Divination · Divination (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":348,\"readerTitle\":\"Divination\"},{\"id\":\"b0350\",\"title\":\"The Emperor's Legion\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"The Emperor's Legion\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":349,\"readerTitle\":\"The Emperor's Legion\"},{\"id\":\"b0351\",\"title\":\"The Regent's Shadow\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"The Regent's Shadow\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":350,\"readerTitle\":\"The Regent's Shadow\"},{\"id\":\"b0352\",\"title\":\"Daemonhammer\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Daemonhammer\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":351,\"readerTitle\":\"Daemonhammer\"},{\"id\":\"b0353\",\"title\":\"Atlas Infernal\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Atlas Infernal\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":352,\"readerTitle\":\"Atlas Infernal\"},{\"id\":\"b0354\",\"title\":\"Deathwatch (Steve Parker)\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Deathwatch (Steve Parker)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":353,\"readerTitle\":\"Deathwatch\"},{\"id\":\"b0355\",\"title\":\"Shadowbreaker\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Shadowbreaker\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":354,\"readerTitle\":\"Shadowbreaker\"},{\"id\":\"b0356\",\"title\":\"Deathwatch (Ian St. Martin)\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Deathwatch (Ian St. Martin)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":355,\"readerTitle\":\"Deathwatch\"},{\"id\":\"b0357\",\"title\":\"Xenos Hunters\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Xenos Hunters · Xenos Hunters (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":356,\"readerTitle\":\"Xenos Hunters\"},{\"id\":\"b0358\",\"title\":\"Deathwatch: Ignition\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Deathwatch: Ignition · Deathwatch: Ignition (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":357,\"readerTitle\":\"Deathwatch: Ignition\"},{\"id\":\"b0359\",\"title\":\"Rites of Passage\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Rites of Passage\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":358,\"readerTitle\":\"Rites of Passage\"},{\"id\":\"b0360\",\"title\":\"Faith and Fire\",\"pl\":null,\"series\":\"ADEPTA SORORITAS\",\"number\":null,\"raw\":\"Faith and Fire\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Sisters of Battle: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Sisters of Battle: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":359,\"readerTitle\":\"Faith and Fire\"},{\"id\":\"b0361\",\"title\":\"Hammer and Anvil\",\"pl\":null,\"series\":\"ADEPTA SORORITAS\",\"number\":null,\"raw\":\"Hammer and Anvil\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: Sisters of Battle: The Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"Sisters of Battle: The Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":360,\"readerTitle\":\"Hammer and Anvil\"},{\"id\":\"b0362\",\"title\":\"Sisters of Battle: The Omnibus\",\"pl\":null,\"series\":\"ADEPTA SORORITAS\",\"number\":null,\"raw\":\"Sisters of Battle: The Omnibus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Faith and Fire\",\"Hammer and Anvil\"],\"readerOffset\":361,\"readerTitle\":\"Sisters of Battle: The Omnibus\"},{\"id\":\"b0363\",\"title\":\"Celestine\",\"pl\":null,\"series\":\"ADEPTA SORORITAS\",\"number\":null,\"raw\":\"Celestine\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":362,\"readerTitle\":\"Celestine\"},{\"id\":\"b0364\",\"title\":\"Requiem Infernal\",\"pl\":null,\"series\":\"ADEPTA SORORITAS\",\"number\":null,\"raw\":\"Requiem Infernal\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Dark Coil: Ascension\"],\"catalogMarker\":\"P\",\"readerOffset\":363,\"readerTitle\":\"Requiem Infernal\"},{\"id\":\"b0365\",\"title\":\"Mark of Faith\",\"pl\":\"Piętno Wiary\",\"series\":\"ADEPTA SORORITAS\",\"number\":null,\"raw\":\"Mark of Faith · Mark of Faith (PL: Piętno Wiary)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":364,\"readerTitle\":\"Mark of Faith\"},{\"id\":\"b0366\",\"title\":\"Pilgrims of Fire\",\"pl\":null,\"series\":\"ADEPTA SORORITAS\",\"number\":null,\"raw\":\"Pilgrims of Fire\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":365,\"readerTitle\":\"Pilgrims of Fire\"},{\"id\":\"b0367\",\"title\":\"The Rose in Darkness\",\"pl\":null,\"series\":\"ADEPTA SORORITAS\",\"number\":null,\"raw\":\"The Rose in Darkness\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":366,\"readerTitle\":\"The Rose in Darkness\"},{\"id\":\"b0368\",\"title\":\"Daemonbreaker\",\"pl\":null,\"series\":\"ADEPTA SORORITAS\",\"number\":null,\"raw\":\"Daemonbreaker\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":367,\"readerTitle\":\"Daemonbreaker\"},{\"id\":\"b0369\",\"title\":\"Morvenn Vahl: Spear of Faith\",\"pl\":null,\"series\":\"ADEPTA SORORITAS\",\"number\":null,\"raw\":\"Morvenn Vahl: Spear of Faith\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":368,\"readerTitle\":\"Morvenn Vahl: Spear of Faith\"},{\"id\":\"b0370\",\"title\":\"Aestred Thurga: Pyre of Faith\",\"pl\":null,\"series\":\"ADEPTA SORORITAS\",\"number\":null,\"raw\":\"Aestred Thurga: Pyre of Faith\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":369,\"readerTitle\":\"Aestred Thurga: Pyre of Faith\"},{\"id\":\"b0371\",\"title\":\"Saints and Martyrs\",\"pl\":null,\"series\":\"ADEPTA SORORITAS\",\"number\":null,\"raw\":\"Saints and Martyrs · Saints and Martyrs (omnibus)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \\nUzupełniona mapa powieści i nowel w zbiorze. Nie wszystkie utwory mają osobny wpis w katalogu. Źródło: https://www.blacklibrary.com/warhammer-40000/novels/ebook-saints-and-martyrs-eng-2024.html\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Celestine\",\"Ephrael Stern: The Heretic Saint\",\"The Triumph of Saint Katherine\"],\"readerOffset\":370,\"readerTitle\":\"Saints and Martyrs\"},{\"id\":\"b0372\",\"title\":\"Priests of Mars\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"Priests of Mars\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Forges of Mars\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Forges of Mars\"],\"catalogMarker\":\"P\",\"readerOffset\":371,\"readerTitle\":\"Priests of Mars\"},{\"id\":\"b0373\",\"title\":\"Lords of Mars\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"Lords of Mars\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Forges of Mars\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Forges of Mars\"],\"catalogMarker\":\"P\",\"readerOffset\":372,\"readerTitle\":\"Lords of Mars\"},{\"id\":\"b0374\",\"title\":\"Gods of Mars\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"Gods of Mars\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Forges of Mars\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Forges of Mars\"],\"catalogMarker\":\"P\",\"readerOffset\":373,\"readerTitle\":\"Gods of Mars\"},{\"id\":\"b0375\",\"title\":\"Skitarius\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"Skitarius\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":374,\"readerTitle\":\"Skitarius\"},{\"id\":\"b0376\",\"title\":\"Tech-Priest\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"Tech-Priest\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":375,\"readerTitle\":\"Tech-Priest\"},{\"id\":\"b0377\",\"title\":\"Belisarius Cawl: The Great Work\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"Belisarius Cawl: The Great Work\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":376,\"readerTitle\":\"Belisarius Cawl: The Great Work\"},{\"id\":\"b0378\",\"title\":\"Belisarius Cawl: Archmagos\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"Belisarius Cawl: Archmagos\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":377,\"readerTitle\":\"Belisarius Cawl: Archmagos\"},{\"id\":\"b0379\",\"title\":\"Day of Ascension\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"Day of Ascension\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":378,\"readerTitle\":\"Day of Ascension\"},{\"id\":\"b0380\",\"title\":\"Dominion Genesis\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"Dominion Genesis\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":379,\"readerTitle\":\"Dominion Genesis\"},{\"id\":\"b0381\",\"title\":\"Servants of the Machine-God\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"Servants of the Machine-God · Servants of the Machine-God (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":380,\"readerTitle\":\"Servants of the Machine-God\"},{\"id\":\"b0382\",\"title\":\"Titanicus\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"Titanicus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":381,\"readerTitle\":\"Titanicus\"},{\"id\":\"b0383\",\"title\":\"Warlord: Fury of the God-Machine\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"Warlord: Fury of the God-Machine\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":382,\"readerTitle\":\"Warlord: Fury of the God-Machine\"},{\"id\":\"b0384\",\"title\":\"Imperator: Wrath of the Omnissiah\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"Imperator: Wrath of the Omnissiah\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":383,\"readerTitle\":\"Imperator: Wrath of the Omnissiah\"},{\"id\":\"b0385\",\"title\":\"Kingsblade\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"Kingsblade\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":384,\"readerTitle\":\"Kingsblade\"},{\"id\":\"b0386\",\"title\":\"Knightsblade\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"Knightsblade\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":385,\"readerTitle\":\"Knightsblade\"},{\"id\":\"b0387\",\"title\":\"Knights of the Imperium\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"Knights of the Imperium · Knights of the Imperium (nowela)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"kind\":\"nowela\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":386,\"readerTitle\":\"Knights of the Imperium\"},{\"id\":\"b0388\",\"title\":\"God-Machines\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"God-Machines · God-Machines (omnibus)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \\nUzupełniona mapa powieści i nowel w zbiorze. Nie wszystkie utwory mają osobny wpis w katalogu. Źródło: https://books.apple.com/us/book/god-machines/id6471418006\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Imperator: Wrath of the Omnissiah\",\"Warlord: Fury of the God-Machine\",\"Kingsblade\",\"Knightsblade\",\"Knights of the Imperium\"],\"readerOffset\":387,\"readerTitle\":\"God-Machines\"},{\"id\":\"b0389\",\"title\":\"Fifteen Hours\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Fifteen Hours\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":388,\"readerTitle\":\"Fifteen Hours\"},{\"id\":\"b0390\",\"title\":\"Death World\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Death World\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":389,\"readerTitle\":\"Death World\"},{\"id\":\"b0391\",\"title\":\"Rebel Winter\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Rebel Winter\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":390,\"readerTitle\":\"Rebel Winter\"},{\"id\":\"b0392\",\"title\":\"Desert Raiders\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Desert Raiders\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":391,\"readerTitle\":\"Desert Raiders\"},{\"id\":\"b0393\",\"title\":\"Ice Guard\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Ice Guard\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":392,\"readerTitle\":\"Ice Guard\"},{\"id\":\"b0394\",\"title\":\"Gunheads\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Gunheads\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":393,\"readerTitle\":\"Gunheads\"},{\"id\":\"b0395\",\"title\":\"Cadian Blood\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Cadian Blood\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":394,\"readerTitle\":\"Cadian Blood\"},{\"id\":\"b0396\",\"title\":\"Redemption Corps\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Redemption Corps\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":395,\"readerTitle\":\"Redemption Corps\"},{\"id\":\"b0397\",\"title\":\"Dead Men Walking\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Dead Men Walking\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":396,\"readerTitle\":\"Dead Men Walking\"},{\"id\":\"b0398\",\"title\":\"Imperial Glory\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Imperial Glory\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":397,\"readerTitle\":\"Imperial Glory\"},{\"id\":\"b0399\",\"title\":\"Iron Guard\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Iron Guard\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":398,\"readerTitle\":\"Iron Guard\"},{\"id\":\"b0400\",\"title\":\"Commissar\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Commissar\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":399,\"readerTitle\":\"Commissar\"},{\"id\":\"b0401\",\"title\":\"Baneblade\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Baneblade\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":400,\"readerTitle\":\"Baneblade\"},{\"id\":\"b0402\",\"title\":\"Straken\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Straken\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":401,\"readerTitle\":\"Straken\"},{\"id\":\"b0403\",\"title\":\"Shadowsword\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Shadowsword\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":402,\"readerTitle\":\"Shadowsword\"},{\"id\":\"b0404\",\"title\":\"Honourbound: Severina Raine\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Honourbound: Severina Raine\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":403,\"readerTitle\":\"Honourbound: Severina Raine\"},{\"id\":\"b0405\",\"title\":\"Steel Tread\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Steel Tread\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":404,\"readerTitle\":\"Steel Tread\"},{\"id\":\"b0406\",\"title\":\"Traitor Rock\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Traitor Rock\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":405,\"readerTitle\":\"Traitor Rock\"},{\"id\":\"b0407\",\"title\":\"Catachan Devil\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Catachan Devil\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":406,\"readerTitle\":\"Catachan Devil\"},{\"id\":\"b0408\",\"title\":\"Kasrkin\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Kasrkin\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":407,\"readerTitle\":\"Kasrkin\"},{\"id\":\"b0409\",\"title\":\"Witchbringer\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Witchbringer\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":408,\"readerTitle\":\"Witchbringer\"},{\"id\":\"b0410\",\"title\":\"Creed: Ashes of Cadia\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Creed: Ashes of Cadia\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":409,\"readerTitle\":\"Creed: Ashes of Cadia\"},{\"id\":\"b0411\",\"title\":\"Longshot\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Longshot\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":410,\"readerTitle\":\"Longshot\"},{\"id\":\"b0412\",\"title\":\"The Fall of Cadia\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"The Fall of Cadia\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":411,\"readerTitle\":\"The Fall of Cadia\"},{\"id\":\"b0413\",\"title\":\"Shadow of the Eighth\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Shadow of the Eighth\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":412,\"readerTitle\":\"Shadow of the Eighth\"},{\"id\":\"b0414\",\"title\":\"Deathworlder\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Deathworlder\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":413,\"readerTitle\":\"Deathworlder\"},{\"id\":\"b0415\",\"title\":\"Leontus: Lord Solar\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Leontus: Lord Solar\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":414,\"readerTitle\":\"Leontus: Lord Solar\"},{\"id\":\"b0416\",\"title\":\"Hell's Last\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Hell's Last\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":415,\"readerTitle\":\"Hell's Last\"},{\"id\":\"b0417\",\"title\":\"Final Deployment\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Final Deployment\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":416,\"readerTitle\":\"Final Deployment\"},{\"id\":\"b0418\",\"title\":\"Demolisher\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Demolisher\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":417,\"readerTitle\":\"Demolisher\"},{\"id\":\"b0419\",\"title\":\"Chem Dog\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Chem Dog\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":418,\"readerTitle\":\"Chem Dog\"},{\"id\":\"b0420\",\"title\":\"Ghosts of Cadia\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Ghosts of Cadia\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":419,\"readerTitle\":\"Ghosts of Cadia\"},{\"id\":\"b0421\",\"title\":\"Voice of Command\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Voice of Command\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":420,\"readerTitle\":\"Voice of Command\"},{\"id\":\"b0422\",\"title\":\"Cold Covenant\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Cold Covenant\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":421,\"readerTitle\":\"Cold Covenant\"},{\"id\":\"b0423\",\"title\":\"Auxilia\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Auxilia\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":422,\"readerTitle\":\"Auxilia\"},{\"id\":\"b0424\",\"title\":\"Cadia Stands\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Cadia Stands\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":423,\"readerTitle\":\"Cadia Stands\"},{\"id\":\"b0425\",\"title\":\"Cadian Honour\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Cadian Honour\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":424,\"readerTitle\":\"Cadian Honour\"},{\"id\":\"b0426\",\"title\":\"The Lords of Silence\",\"pl\":null,\"series\":\"CHAOS: DEATH GUARD\",\"number\":null,\"raw\":\"The Lords of Silence\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":425,\"readerTitle\":\"The Lords of Silence\"},{\"id\":\"b0427\",\"title\":\"Spear of the Emperor\",\"pl\":null,\"series\":\"INNE ZAKONY SPACE MARINES\",\"number\":null,\"raw\":\"Spear of the Emperor\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":426,\"readerTitle\":\"Spear of the Emperor\"},{\"id\":\"b0428\",\"title\":\"Lords and Tyrants\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Lords and Tyrants · Lords and Tyrants (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":427,\"readerTitle\":\"Lords and Tyrants\"},{\"id\":\"b0429\",\"title\":\"Shroud of Night\",\"pl\":null,\"series\":\"CHAOS: ALPHA LEGION\",\"number\":null,\"raw\":\"Shroud of Night\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":428,\"readerTitle\":\"Shroud of Night\"},{\"id\":\"b0430\",\"title\":\"Sons of the Hydra\",\"pl\":null,\"series\":\"CHAOS: ALPHA LEGION\",\"number\":null,\"raw\":\"Sons of the Hydra\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":429,\"readerTitle\":\"Sons of the Hydra\"},{\"id\":\"b0431\",\"title\":\"Outgunned\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Outgunned\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":430,\"readerTitle\":\"Outgunned\"},{\"id\":\"b0432\",\"title\":\"Above and Beyond\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Above and Beyond\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":431,\"readerTitle\":\"Above and Beyond\"},{\"id\":\"b0433\",\"title\":\"Krieg\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Krieg\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":432,\"readerTitle\":\"Krieg\"},{\"id\":\"b0434\",\"title\":\"Siege of Vraks\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Siege of Vraks\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":433,\"readerTitle\":\"Siege of Vraks\"},{\"id\":\"b0435\",\"title\":\"The Relentless Dead\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"The Relentless Dead\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":434,\"readerTitle\":\"The Relentless Dead\"},{\"id\":\"b0436\",\"title\":\"Death Rider\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Death Rider\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":435,\"readerTitle\":\"Death Rider\"},{\"id\":\"b0437\",\"title\":\"Death and Duty\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Death and Duty · Death and Duty (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":436,\"readerTitle\":\"Death and Duty\"},{\"id\":\"b0438\",\"title\":\"Cult of the Warmason\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Cult of the Warmason\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":437,\"readerTitle\":\"Cult of the Warmason\"},{\"id\":\"b0439\",\"title\":\"Cult of the Spiral Dawn\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Cult of the Spiral Dawn\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Dark Coil: Damnation\"],\"catalogMarker\":\"P\",\"readerOffset\":438,\"readerTitle\":\"Cult of the Spiral Dawn\"},{\"id\":\"b0440\",\"title\":\"Genestealer Cults\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Genestealer Cults\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":439,\"readerTitle\":\"Genestealer Cults\"},{\"id\":\"b0441\",\"title\":\"Emperor's Mercy\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Emperor's Mercy\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":440,\"readerTitle\":\"Emperor's Mercy\"},{\"id\":\"b0442\",\"title\":\"Flesh and Iron\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Flesh and Iron\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":441,\"readerTitle\":\"Flesh and Iron\"},{\"id\":\"b0443\",\"title\":\"Blood Gorgons\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Blood Gorgons\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":442,\"readerTitle\":\"Blood Gorgons\"},{\"id\":\"b0444\",\"title\":\"Rogue Star (Rogue Trader)\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Rogue Star (Rogue Trader)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":443,\"readerTitle\":\"Rogue Star\"},{\"id\":\"b0445\",\"title\":\"Star of Damocles\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Star of Damocles\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":444,\"readerTitle\":\"Star of Damocles\"},{\"id\":\"b0446\",\"title\":\"Crossfire (Calpurnia)\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Crossfire (Calpurnia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":445,\"readerTitle\":\"Crossfire\"},{\"id\":\"b0447\",\"title\":\"Legacy\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Legacy\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Shira Calpurnia Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Shira Calpurnia Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":446,\"readerTitle\":\"Legacy\"},{\"id\":\"b0448\",\"title\":\"Blind\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Blind\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Shira Calpurnia Omnibus\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Shira Calpurnia Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":447,\"readerTitle\":\"Blind\"},{\"id\":\"b0449\",\"title\":\"Enforcer: The Shira Calpurnia Omnibus\",\"pl\":null,\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"number\":null,\"raw\":\"Enforcer: The Shira Calpurnia Omnibus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \\nUzupełniona mapa powieści i nowel w zbiorze. Nie wszystkie utwory mają osobny wpis w katalogu. Źródło: https://www.simonandschuster.co.uk/books/Enforcer/Matthew-Farrer/Shira-Calpurnia/9781784967321\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"contents\":[\"Crossfire (Calpurnia)\",\"Legacy\",\"Blind\"],\"readerOffset\":448,\"readerTitle\":\"Enforcer: The Shira Calpurnia Omnibus\"},{\"id\":\"b0450\",\"title\":\"Path of the Warrior\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Path of the Warrior\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":449,\"readerTitle\":\"Path of the Warrior\"},{\"id\":\"b0451\",\"title\":\"Path of the Seer\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Path of the Seer\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":450,\"readerTitle\":\"Path of the Seer\"},{\"id\":\"b0452\",\"title\":\"Path of the Outcast\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Path of the Outcast\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":451,\"readerTitle\":\"Path of the Outcast\"},{\"id\":\"b0453\",\"title\":\"Eldar Prophecy\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Eldar Prophecy\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":452,\"readerTitle\":\"Eldar Prophecy\"},{\"id\":\"b0454\",\"title\":\"Asurmen: Hand of Asuryan\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Asurmen: Hand of Asuryan\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":453,\"readerTitle\":\"Asurmen: Hand of Asuryan\"},{\"id\":\"b0455\",\"title\":\"Jain Zar: The Storm of Silence\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Jain Zar: The Storm of Silence\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":454,\"readerTitle\":\"Jain Zar: The Storm of Silence\"},{\"id\":\"b0456\",\"title\":\"Ghost Warrior\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Ghost Warrior\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":455,\"readerTitle\":\"Ghost Warrior\"},{\"id\":\"b0457\",\"title\":\"Wild Rider\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Wild Rider\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":456,\"readerTitle\":\"Wild Rider\"},{\"id\":\"b0458\",\"title\":\"Path of the Renegade\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Path of the Renegade\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":457,\"readerTitle\":\"Path of the Renegade\"},{\"id\":\"b0459\",\"title\":\"Path of the Incubus\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Path of the Incubus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":458,\"readerTitle\":\"Path of the Incubus\"},{\"id\":\"b0460\",\"title\":\"Path of the Archon\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Path of the Archon\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":459,\"readerTitle\":\"Path of the Archon\"},{\"id\":\"b0461\",\"title\":\"Lelith Hesperax: Queen of Knives\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Lelith Hesperax: Queen of Knives\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":460,\"readerTitle\":\"Lelith Hesperax: Queen of Knives\"},{\"id\":\"b0462\",\"title\":\"Fire Warrior\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Fire Warrior\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":461,\"readerTitle\":\"Fire Warrior\"},{\"id\":\"b0463\",\"title\":\"Farsight\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Farsight\",\"uncertain\":true,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. UWAGA: Może oznaczać nowelę; zweryfikować format konkretnego wydania drukowanego.\",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":462,\"readerTitle\":\"Farsight\"},{\"id\":\"b0464\",\"title\":\"Farsight: Crisis of Faith\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Farsight: Crisis of Faith\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":463,\"readerTitle\":\"Farsight: Crisis of Faith\"},{\"id\":\"b0465\",\"title\":\"Farsight: Empire of Lies\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Farsight: Empire of Lies\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":464,\"readerTitle\":\"Farsight: Empire of Lies\"},{\"id\":\"b0466\",\"title\":\"Farsight: Blade of Truth\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Farsight: Blade of Truth\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":465,\"readerTitle\":\"Farsight: Blade of Truth\"},{\"id\":\"b0467\",\"title\":\"Shadowsun: The Patient Hunter\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Shadowsun: The Patient Hunter\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":466,\"readerTitle\":\"Shadowsun: The Patient Hunter\"},{\"id\":\"b0468\",\"title\":\"Elemental Council\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Elemental Council\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":467,\"readerTitle\":\"Elemental Council\"},{\"id\":\"b0469\",\"title\":\"Voidscarred\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Voidscarred\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":468,\"readerTitle\":\"Voidscarred\"},{\"id\":\"b0470\",\"title\":\"Oaths of Damnation\",\"pl\":null,\"series\":\"XENOS: AELDARI / T’AU\",\"number\":null,\"raw\":\"Oaths of Damnation\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":469,\"readerTitle\":\"Oaths of Damnation\"},{\"id\":\"b0471\",\"title\":\"Brutal Kunnin\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"Brutal Kunnin\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":470,\"readerTitle\":\"Brutal Kunnin\"},{\"id\":\"b0472\",\"title\":\"Warboss\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"Warboss\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":471,\"readerTitle\":\"Warboss\"},{\"id\":\"b0473\",\"title\":\"Ghazghkull Thraka: Prophet of the Waaagh!\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"Ghazghkull Thraka: Prophet of the Waaagh!\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":472,\"readerTitle\":\"Ghazghkull Thraka: Prophet of the Waaagh!\"},{\"id\":\"b0474\",\"title\":\"Da Big Dakka\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"Da Big Dakka\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":473,\"readerTitle\":\"Da Big Dakka\"},{\"id\":\"b0475\",\"title\":\"Long Live Da Red Gobbo\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"Long Live Da Red Gobbo\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":474,\"readerTitle\":\"Long Live Da Red Gobbo\"},{\"id\":\"b0476\",\"title\":\"Grotsnik: Da Mad Dok\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"Grotsnik: Da Mad Dok\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":475,\"readerTitle\":\"Grotsnik: Da Mad Dok\"},{\"id\":\"b0477\",\"title\":\"Ghazghkull Thraka: Warlord of Warlords\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"Ghazghkull Thraka: Warlord of Warlords\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":476,\"readerTitle\":\"Ghazghkull Thraka: Warlord of Warlords\"},{\"id\":\"b0478\",\"title\":\"Da Freebooterz Code\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"Da Freebooterz Code\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":477,\"readerTitle\":\"Da Freebooterz Code\"},{\"id\":\"b0479\",\"title\":\"Severed\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"Severed\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":478,\"readerTitle\":\"Severed\"},{\"id\":\"b0480\",\"title\":\"The Twice-Dead King: Ruin\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"The Twice-Dead King: Ruin · Ruin\",\"uncertain\":true,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Twice-Dead King: Omnibus\\nUWAGA: Powieść The Twice-Dead King: Ruin.\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Twice-Dead King: Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":479,\"readerTitle\":\"Ruin\"},{\"id\":\"b0481\",\"title\":\"The Twice-Dead King: Reign\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"The Twice-Dead King: Reign · Reign\",\"uncertain\":true,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. W zbiorze: The Twice-Dead King: Omnibus\\nUWAGA: Powieść The Twice-Dead King: Reign.\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Twice-Dead King: Omnibus\"],\"catalogMarker\":\"P\",\"readerOffset\":480,\"readerTitle\":\"Reign\"},{\"id\":\"b0482\",\"title\":\"The Infinite and the Divine\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"The Infinite and the Divine\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":481,\"readerTitle\":\"The Infinite and the Divine\"},{\"id\":\"b0483\",\"title\":\"Tomb World\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"Tomb World\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":482,\"readerTitle\":\"Tomb World\"},{\"id\":\"b0484\",\"title\":\"The Wicked and the Warped\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"The Wicked and the Warped\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":483,\"readerTitle\":\"The Wicked and the Warped\"},{\"id\":\"b0485\",\"title\":\"Hive\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"Hive\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":484,\"readerTitle\":\"Hive\"},{\"id\":\"b0486\",\"title\":\"Armageddon: Season of Fire\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"Armageddon: Season of Fire\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":485,\"readerTitle\":\"Armageddon: Season of Fire\"},{\"id\":\"b0487\",\"title\":\"Ghost Legion\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"Ghost Legion\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":486,\"readerTitle\":\"Ghost Legion\"},{\"id\":\"b0488\",\"title\":\"Blackstone Fortress\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"Blackstone Fortress\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":487,\"readerTitle\":\"Blackstone Fortress\"},{\"id\":\"b0489\",\"title\":\"Ascension (Blackstone Fortress)\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"Ascension (Blackstone Fortress)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":488,\"readerTitle\":\"Ascension\"},{\"id\":\"b0490\",\"title\":\"Void King\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"Void King\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":489,\"readerTitle\":\"Void King\"},{\"id\":\"b0491\",\"title\":\"Status: Deadzone\",\"pl\":\"Strefa śmierci, antologia Necromundy\",\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Status: Deadzone · Status: Deadzone (PL: Strefa śmierci, antologia Necromundy)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":490,\"readerTitle\":\"Status: Deadzone\"},{\"id\":\"b0492\",\"title\":\"Survival Instinct\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Survival Instinct\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":491,\"readerTitle\":\"Survival Instinct\"},{\"id\":\"b0493\",\"title\":\"Salvation\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Salvation\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":492,\"readerTitle\":\"Salvation\"},{\"id\":\"b0494\",\"title\":\"Blood Royal\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Blood Royal\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":493,\"readerTitle\":\"Blood Royal\"},{\"id\":\"b0495\",\"title\":\"Junktion\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Junktion\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":494,\"readerTitle\":\"Junktion\"},{\"id\":\"b0496\",\"title\":\"Fleshworks\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Fleshworks\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":495,\"readerTitle\":\"Fleshworks\"},{\"id\":\"b0497\",\"title\":\"Cardinal Crimson\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Cardinal Crimson\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":496,\"readerTitle\":\"Cardinal Crimson\"},{\"id\":\"b0498\",\"title\":\"Back from the Dead\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Back from the Dead\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":497,\"readerTitle\":\"Back from the Dead\"},{\"id\":\"b0499\",\"title\":\"Outlander\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Outlander\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":498,\"readerTitle\":\"Outlander\"},{\"id\":\"b0500\",\"title\":\"Lasgun Wedding\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Lasgun Wedding\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":499,\"readerTitle\":\"Lasgun Wedding\"},{\"id\":\"b0501\",\"title\":\"Terminal Overkill\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Terminal Overkill\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":500,\"readerTitle\":\"Terminal Overkill\"},{\"id\":\"b0502\",\"title\":\"Kal Jerico: Sinner's Bounty\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Kal Jerico: Sinner's Bounty\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":501,\"readerTitle\":\"Kal Jerico: Sinner's Bounty\"},{\"id\":\"b0503\",\"title\":\"Road to Redemption\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Road to Redemption\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":502,\"readerTitle\":\"Road to Redemption\"},{\"id\":\"b0504\",\"title\":\"Soulless Fury\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Soulless Fury\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":503,\"readerTitle\":\"Soulless Fury\"},{\"id\":\"b0505\",\"title\":\"Fire Made Flesh\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Fire Made Flesh\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":504,\"readerTitle\":\"Fire Made Flesh\"},{\"id\":\"b0506\",\"title\":\"Underhive\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Underhive · Underhive (antologia)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":505,\"readerTitle\":\"Underhive\"},{\"id\":\"b0508\",\"title\":\"Broken City\",\"pl\":null,\"series\":\"WARHAMMER CRIME\",\"number\":null,\"raw\":\"Broken City\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":507,\"readerTitle\":\"Broken City\"},{\"id\":\"b0509\",\"title\":\"No Good Men\",\"pl\":null,\"series\":\"WARHAMMER CRIME\",\"number\":null,\"raw\":\"No Good Men\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":508,\"readerTitle\":\"No Good Men\"},{\"id\":\"b0510\",\"title\":\"Sanction and Sin\",\"pl\":null,\"series\":\"WARHAMMER CRIME\",\"number\":null,\"raw\":\"Sanction and Sin\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":509,\"readerTitle\":\"Sanction and Sin\"},{\"id\":\"b0511\",\"title\":\"The Vorbis Conspiracy\",\"pl\":null,\"series\":\"WARHAMMER CRIME\",\"number\":null,\"raw\":\"The Vorbis Conspiracy\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":510,\"readerTitle\":\"The Vorbis Conspiracy\"},{\"id\":\"b0512\",\"title\":\"Once a Killer\",\"pl\":null,\"series\":\"WARHAMMER CRIME\",\"number\":null,\"raw\":\"Once a Killer\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":511,\"readerTitle\":\"Once a Killer\"},{\"id\":\"b0513\",\"title\":\"Assassinorum Kingmaker\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Assassinorum Kingmaker\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":512,\"readerTitle\":\"Assassinorum Kingmaker\"},{\"id\":\"b0514\",\"title\":\"13th Legion\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"13th Legion · Thirteenth Legion\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":513,\"readerTitle\":\"Thirteenth Legion\"},{\"id\":\"b0515\",\"title\":\"Kill Team\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Kill Team\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":514,\"readerTitle\":\"Kill Team\"},{\"id\":\"b0516\",\"title\":\"Annihilation Squad\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Annihilation Squad\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":515,\"readerTitle\":\"Annihilation Squad\"},{\"id\":\"b0517\",\"title\":\"Armageddon Saint\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Armageddon Saint\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":516,\"readerTitle\":\"Armageddon Saint\"},{\"id\":\"b0518\",\"title\":\"The High Kâhl's Oath\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"The High Kâhl's Oath\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":517,\"readerTitle\":\"The High Kâhl's Oath\"},{\"id\":\"b0519\",\"title\":\"Space Marine (Ian Watson)\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Space Marine (Ian Watson)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":518,\"readerTitle\":\"Space Marine\"},{\"id\":\"b0520\",\"title\":\"Farseer\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Farseer\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":519,\"readerTitle\":\"Farseer\"},{\"id\":\"b0521\",\"title\":\"Relentless\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Relentless\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":520,\"readerTitle\":\"Relentless\"},{\"id\":\"b0522\",\"title\":\"Assault on Black Reach\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Assault on Black Reach\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":521,\"readerTitle\":\"Assault on Black Reach\"},{\"id\":\"b0523\",\"title\":\"Space Hulk: The Novel\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Space Hulk: The Novel\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":522,\"readerTitle\":\"Space Hulk: The Novel\"},{\"id\":\"b0524\",\"title\":\"Sons of Dorn\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Sons of Dorn\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":523,\"readerTitle\":\"Sons of Dorn\"},{\"id\":\"b0525\",\"title\":\"Genefather\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Genefather\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":524,\"readerTitle\":\"Genefather\"},{\"id\":\"b0526\",\"title\":\"Angron: The Red Angel\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Angron: The Red Angel\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":525,\"readerTitle\":\"Angron: The Red Angel\"},{\"id\":\"b0527\",\"title\":\"Vagabond Squadron\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Vagabond Squadron\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":526,\"readerTitle\":\"Vagabond Squadron\"},{\"id\":\"b0528\",\"title\":\"Eye of Terror\",\"pl\":\"Oko Terroru\",\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Eye of Terror · Eye of Terror (PL: Oko Terroru)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":527,\"readerTitle\":\"Eye of Terror\"},{\"id\":\"b0529\",\"title\":\"Angel of Fire\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Angel of Fire\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":528,\"readerTitle\":\"Angel of Fire\"},{\"id\":\"b0530\",\"title\":\"Fist of Demetrius\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Fist of Demetrius\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":529,\"readerTitle\":\"Fist of Demetrius\"},{\"id\":\"b0531\",\"title\":\"Fall of Macharius\",\"pl\":null,\"series\":\"NECROMUNDA / INNE 40K\",\"number\":null,\"raw\":\"Fall of Macharius\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"powieść\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":530,\"readerTitle\":\"Fall of Macharius\"},{\"id\":\"b0532\",\"title\":\"Deathwing\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Deathwing\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":531,\"readerTitle\":\"Deathwing\"},{\"id\":\"b0533\",\"title\":\"Into the Maelstrom\",\"pl\":\"W głąb Maelstromu\",\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Into the Maelstrom · Into the Maelstrom (PL: W głąb Maelstromu)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":532,\"readerTitle\":\"Into the Maelstrom\"},{\"id\":\"b0534\",\"title\":\"Dark Imperium\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Dark Imperium · Dark Imperium (antologia 2001)\",\"uncertain\":true,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. UWAGA: Uwaga: występuje zarówno powieść, jak i antologia z 2001 r.\",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":533,\"readerTitle\":\"Dark Imperium\"},{\"id\":\"b0535\",\"title\":\"Words of Blood\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Words of Blood\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":534,\"readerTitle\":\"Words of Blood\"},{\"id\":\"b0536\",\"title\":\"Crucible of War\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Crucible of War\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":535,\"readerTitle\":\"Crucible of War\"},{\"id\":\"b0537\",\"title\":\"What Price Victory\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"What Price Victory\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":536,\"readerTitle\":\"What Price Victory\"},{\"id\":\"b0538\",\"title\":\"Bringers of Death\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Bringers of Death\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":537,\"readerTitle\":\"Bringers of Death\"},{\"id\":\"b0539\",\"title\":\"Let the Galaxy Burn\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Let the Galaxy Burn\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":538,\"readerTitle\":\"Let the Galaxy Burn\"},{\"id\":\"b0540\",\"title\":\"Tales from the Dark Millennium\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Tales from the Dark Millennium\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":539,\"readerTitle\":\"Tales from the Dark Millennium\"},{\"id\":\"b0541\",\"title\":\"Planetkill\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Planetkill\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":540,\"readerTitle\":\"Planetkill\"},{\"id\":\"b0542\",\"title\":\"The Book of Blood\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"The Book of Blood\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":541,\"readerTitle\":\"The Book of Blood\"},{\"id\":\"b0543\",\"title\":\"Fear the Alien\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Fear the Alien\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":542,\"readerTitle\":\"Fear the Alien\"},{\"id\":\"b0544\",\"title\":\"There Is Only War\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"There Is Only War\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":543,\"readerTitle\":\"There Is Only War\"},{\"id\":\"b0545\",\"title\":\"Heroes of the Space Marines\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Heroes of the Space Marines\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":544,\"readerTitle\":\"Heroes of the Space Marines\"},{\"id\":\"b0546\",\"title\":\"Legends of the Space Marines\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Legends of the Space Marines\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":545,\"readerTitle\":\"Legends of the Space Marines\"},{\"id\":\"b0547\",\"title\":\"Victories of the Space Marines\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Victories of the Space Marines\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":546,\"readerTitle\":\"Victories of the Space Marines\"},{\"id\":\"b0548\",\"title\":\"Treacheries of the Space Marines\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Treacheries of the Space Marines\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":547,\"readerTitle\":\"Treacheries of the Space Marines\"},{\"id\":\"b0549\",\"title\":\"Honour of the Space Marines\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Honour of the Space Marines\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":548,\"readerTitle\":\"Honour of the Space Marines\"},{\"id\":\"b0550\",\"title\":\"Galaxy of Horrors\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Galaxy of Horrors\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":549,\"readerTitle\":\"Galaxy of Horrors\"},{\"id\":\"b0551\",\"title\":\"Blood of the Imperium\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Blood of the Imperium\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":550,\"readerTitle\":\"Blood of the Imperium\"},{\"id\":\"b0552\",\"title\":\"Darkness Eternal\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Darkness Eternal\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":551,\"readerTitle\":\"Darkness Eternal\"},{\"id\":\"b0553\",\"title\":\"No Peace Among Stars\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"No Peace Among Stars\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":552,\"readerTitle\":\"No Peace Among Stars\"},{\"id\":\"b0554\",\"title\":\"Carnage Unending\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"Carnage Unending\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":553,\"readerTitle\":\"Carnage Unending\"},{\"id\":\"b0555\",\"title\":\"World Ablaze\",\"pl\":null,\"series\":\"ANTOLOGIE KLASYCZNE\",\"number\":null,\"raw\":\"World Ablaze\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Typ lub wariant wydania wymaga potwierdzenia. \",\"kind\":\"antologia\",\"omnibusTitles\":[],\"catalogMarker\":\"P\",\"readerOffset\":554,\"readerTitle\":\"World Ablaze\"},{\"id\":\"b0556\",\"title\":\"The Founding\",\"pl\":null,\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":null,\"raw\":\"The Founding\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"First and Only\",\"Ghostmaker\",\"Necropolis\"]},{\"id\":\"b0557\",\"title\":\"The Lost\",\"pl\":null,\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":null,\"raw\":\"The Lost\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"Traitor General\",\"His Last Command\",\"The Armour of Contempt\",\"Only in Death\"]},{\"id\":\"b0558\",\"title\":\"Gaunt's Ghosts: The Victory (Part Two)\",\"pl\":null,\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"number\":null,\"raw\":\"Gaunt's Ghosts: The Victory (Part Two) · The Victory\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"The Warmaster\",\"Anarch\"]},{\"id\":\"b0559\",\"title\":\"Ravenor: The Omnibus\",\"pl\":null,\"series\":\"EISENHORN / RAVENOR / BEQUIN\",\"number\":null,\"raw\":\"Ravenor: The Omnibus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"Ravenor\",\"Ravenor Returned\",\"Ravenor Rogue\"]},{\"id\":\"b0560\",\"title\":\"Ciaphas Cain: Hero of the Imperium\",\"pl\":null,\"series\":\"CIAPHAS CAIN\",\"number\":null,\"raw\":\"Ciaphas Cain: Hero of the Imperium\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"For the Emperor\",\"Caves of Ice\",\"The Traitor’s Hand\"]},{\"id\":\"b0561\",\"title\":\"Ciaphas Cain: Defender of the Imperium\",\"pl\":null,\"series\":\"CIAPHAS CAIN\",\"number\":null,\"raw\":\"Ciaphas Cain: Defender of the Imperium\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"Death or Glory\",\"Duty Calls\",\"Cain’s Last Stand\"]},{\"id\":\"b0562\",\"title\":\"Ciaphas Cain: Saviour of the Imperium\",\"pl\":null,\"series\":\"CIAPHAS CAIN\",\"number\":null,\"raw\":\"Ciaphas Cain: Saviour of the Imperium\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"The Emperor’s Finest\",\"The Last Ditch\",\"The Greater Good\"]},{\"id\":\"b0563\",\"title\":\"The Space Wolf Omnibus (Volume 1)\",\"pl\":null,\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"The Space Wolf Omnibus (Volume 1) · The Space Wolf Omnibus (tom 1)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"Space Wolf\",\"Ragnar’s Claw\",\"Grey Hunter\"]},{\"id\":\"b0564\",\"title\":\"The Space Wolf Omnibus (Volume 2)\",\"pl\":null,\"series\":\"SPACE WOLVES\",\"number\":null,\"raw\":\"The Space Wolf Omnibus (Volume 2) · The Space Wolf Omnibus (tom 2)\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"Wolfblade\",\"Sons of Fenris\",\"Wolf’s Honour\"]},{\"id\":\"b0565\",\"title\":\"The Ultramarines Omnibus\",\"pl\":null,\"series\":\"ULTRAMARINES\",\"number\":null,\"raw\":\"The Ultramarines Omnibus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"Nightbringer\",\"Warriors of Ultramar\",\"Dead Sky, Black Sun\"]},{\"id\":\"b0566\",\"title\":\"The Ultramarines Omnibus 2\",\"pl\":null,\"series\":\"ULTRAMARINES\",\"number\":null,\"raw\":\"The Ultramarines Omnibus 2\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"The Killing Ground\",\"Courage and Honour\",\"The Chapter’s Due\"]},{\"id\":\"b0567\",\"title\":\"Legacy of Caliban\",\"pl\":null,\"series\":\"DARK ANGELS\",\"number\":null,\"raw\":\"Legacy of Caliban\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"Ravenwing\",\"Master of Sanctity\",\"The Unforgiven\"]},{\"id\":\"b0568\",\"title\":\"Soul Drinkers: The Omnibus\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Soul Drinkers: The Omnibus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"Soul Drinker (Soul Drinkers)\",\"The Bleeding Chalice\",\"Crimson Tears\"]},{\"id\":\"b0569\",\"title\":\"Soul Drinkers: Annihilation\",\"pl\":null,\"series\":\"CHAOS\",\"number\":null,\"raw\":\"Soul Drinkers: Annihilation\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"Chapter War\",\"Hellforged\",\"Phalanx\"]},{\"id\":\"b0570\",\"title\":\"The Forges of Mars\",\"pl\":null,\"series\":\"MECHANICUS / TYTANY / RYCERZE\",\"number\":null,\"raw\":\"The Forges of Mars\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"Priests of Mars\",\"Lords of Mars\",\"Gods of Mars\"]},{\"id\":\"b0571\",\"title\":\"The Shira Calpurnia Omnibus\",\"pl\":null,\"series\":\"SHIRA CALPURNIA\",\"number\":null,\"raw\":\"The Shira Calpurnia Omnibus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"Crossfire (Calpurnia)\",\"Legacy\",\"Blind\"]},{\"id\":\"b0572\",\"title\":\"The Twice-Dead King: Omnibus\",\"pl\":null,\"series\":\"XENOS: ORKOWIE / NEKRONI / TYRANIDZI\",\"number\":null,\"raw\":\"The Twice-Dead King: Omnibus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"The Twice-Dead King: Ruin\",\"The Twice-Dead King: Reign\"]},{\"id\":\"b0573\",\"title\":\"Grey Knights: The Omnibus\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Grey Knights: The Omnibus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"Grey Knights\",\"Dark Adeptus\",\"Hammer of Daemons\"]},{\"id\":\"b0574\",\"title\":\"Vaults of Terra: The Omnibus\",\"pl\":null,\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"number\":null,\"raw\":\"Vaults of Terra: The Omnibus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"The Carrion Throne (Wraight)\",\"The Hollow Mountain\",\"The Dark City\"]},{\"id\":\"b0575\",\"title\":\"The Beast Arises: Volume 1\",\"pl\":null,\"series\":\"THE BEAST ARISES\",\"number\":null,\"raw\":\"The Beast Arises: Volume 1\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"I Am Slaughter\",\"Predator, Prey\",\"The Emperor Expects\",\"The Last Wall\"]},{\"id\":\"b0576\",\"title\":\"The Beast Arises: Volume 2\",\"pl\":null,\"series\":\"THE BEAST ARISES\",\"number\":null,\"raw\":\"The Beast Arises: Volume 2\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"Throneworld\",\"Echoes of the Long War\",\"The Hunt for Vulkan\",\"The Beast Must Die\"]},{\"id\":\"b0577\",\"title\":\"The Beast Arises: Volume 3\",\"pl\":null,\"series\":\"THE BEAST ARISES\",\"number\":null,\"raw\":\"The Beast Arises: Volume 3\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Zawartość według skorygowanego PDF. Wydanie i ISBN należy potwierdzić dla konkretnego egzemplarza.\\nMapa obejmuje główne powieści; dodatkowe utwory mogą zależeć od wydania.\",\"kind\":\"omnibus\",\"catalogMarker\":\"M\",\"omnibusTitles\":[],\"contents\":[\"Watchers in Death\",\"The Last Son of Dorn\",\"Shadow of Ullanor\",\"The Beheading\"]},{\"id\":\"b0578\",\"title\":\"Night Lords: The Omnibus\",\"pl\":null,\"series\":\"KOLEKCJE OMNIBUSOWE\",\"number\":null,\"raw\":\"Night Lords: The Omnibus\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Uzupełnienie katalogu poza listą PDF. Autor: Aaron Dembski-Bowden. Zbiór zawiera powieści Soul Hunter, Blood Reaver i Void Stalker oraz dodatkowe opowiadania. Mapa rozwijanych książek obejmuje trzy główne powieści. Zawartość potwierdzona przez wydawcę: https://www.warhammer-community.com/en-gb/articles/gq1wmtzs/saturday-pre-orders-return-to-the-underworlds/\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\",\"omnibusTitles\":[],\"contents\":[\"Soul Hunter (Night Lords)\",\"Blood Reaver\",\"Void Stalker\"]},{\"id\":\"b0579\",\"title\":\"The Dark Coil: Ascension\",\"pl\":null,\"series\":\"KOLEKCJE OMNIBUSOWE\",\"number\":null,\"raw\":\"The Dark Coil: Ascension · The Dark Coil: Ascension — Peter Fehervari\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Uzupełnienie katalogu poza listą PDF. Autor: Peter Fehervari. Dane potwierdzone przez wydawcę: https://www.simonandschuster.com/books/The-Dark-Coil-Ascension/Peter-Fehervari/Warhammer-40-000/9781836090144\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"+\",\"contents\":[\"The Reverie\",\"The Crown of Thorns\",\"The Sins of My Brothers\",\"The Thirteenth Psalm\",\"Nightbleed\",\"Nightshift Nineteen\",\"Requiem Infernal\",\"Aria Arcana\",\"The Walker in Fire\",\"Nightfall\"]},{\"id\":\"b0580\",\"title\":\"The Dark Coil: Damnation\",\"pl\":null,\"series\":\"KOLEKCJE OMNIBUSOWE\",\"number\":null,\"raw\":\"The Dark Coil: Damnation · The Dark Coil: Damnation — Peter Fehervari\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Uzupełnienie katalogu poza listą PDF. Autor: Peter Fehervari. Dane potwierdzone przez wydawcę: https://www.simonandschuster.com/books/The-Dark-Coil-Damnation/Peter-Fehervari/Warhammer-40-000/9781836090007 Zawartość obejmuje główne powieści; zbiór zawiera również opowiadania.\",\"kind\":\"omnibus\",\"omnibusTitles\":[],\"catalogMarker\":\"+\",\"contents\":[\"Fire Caste\",\"Cult of the Spiral Dawn\"]},{\"id\":\"b0581\",\"title\":\"The Reverie\",\"pl\":null,\"series\":\"THE DARK COIL\",\"number\":null,\"raw\":\"The Reverie · The Reverie — Peter Fehervari\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Uzupełnienie katalogu poza listą PDF. Autor: Peter Fehervari. Dane potwierdzone przez wydawcę: https://www.simonandschuster.com/books/The-Dark-Coil-Ascension/Peter-Fehervari/Warhammer-40-000/9781836090144\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Dark Coil: Ascension\"],\"catalogMarker\":\"+\"},{\"id\":\"b0582\",\"title\":\"Fire Caste\",\"pl\":null,\"series\":\"THE DARK COIL\",\"number\":null,\"raw\":\"Fire Caste · Fire Caste — Peter Fehervari\",\"uncertain\":false,\"note\":\"Źródło: katalog papierowy z 12.10.2026. Uzupełnienie katalogu poza listą PDF. Autor: Peter Fehervari. Dane potwierdzone przez wydawcę: https://www.simonandschuster.com/books/The-Dark-Coil-Damnation/Peter-Fehervari/Warhammer-40-000/9781836090007\",\"kind\":\"powieść\",\"omnibusTitles\":[\"The Dark Coil: Damnation\"],\"catalogMarker\":\"+\"},{\"id\":\"b0583\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Gaunt's Ghosts: The Victory (Part One)\",\"series\":\"GAUNT’S GHOSTS / SABBAT WORLDS\",\"raw\":\"Gaunt's Ghosts: The Victory (Part One)\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0584\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Seventh Retribution\",\"series\":\"INNE ZAKONY SPACE MARINES\",\"raw\":\"Seventh Retribution\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0585\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Legacy of Dorn\",\"series\":\"INNE ZAKONY SPACE MARINES\",\"raw\":\"Legacy of Dorn\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0586\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Remnant Blade\",\"series\":\"INNE ZAKONY SPACE MARINES\",\"raw\":\"The Remnant Blade\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0587\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Helbrecht: Sin of Hope\",\"series\":\"INNE ZAKONY SPACE MARINES\",\"raw\":\"Helbrecht: Sin of Hope\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0588\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Red Path\",\"series\":\"CHAOS\",\"raw\":\"The Red Path\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0589\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Fulgrim: The Perfect Son\",\"series\":\"CHAOS\",\"raw\":\"Fulgrim: The Perfect Son\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0590\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Assassinorum: Execution Force\",\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"raw\":\"Assassinorum: Execution Force\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0591\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Draco\",\"series\":\"INKWIZYCJA / GREY KNIGHTS / DEATHWATCH\",\"raw\":\"Draco\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0592\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Bloodied Rose\",\"series\":\"ADEPTA SORORITAS\",\"raw\":\"The Bloodied Rose\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0593\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Wreck and Ruin\",\"series\":\"ADEPTA SORORITAS\",\"raw\":\"Wreck and Ruin\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0594\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Rose in Anger\",\"series\":\"ADEPTA SORORITAS\",\"raw\":\"The Rose in Anger\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0595\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Veterans of the Fall\",\"series\":\"ASTRA MILITARUM I INNE IMPERIUM\",\"raw\":\"Veterans of the Fall\",\"kind\":\"zbiór\",\"catalogMarker\":\"+\"},{\"id\":\"b0596\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Valedor\",\"series\":\"XENOS: AELDARI / T’AU\",\"raw\":\"Valedor\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0597\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Bloodlines\",\"series\":\"WARHAMMER CRIME\",\"raw\":\"Bloodlines\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0598\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Flesh and Steel\",\"series\":\"WARHAMMER CRIME\",\"raw\":\"Flesh and Steel\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0599\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Grim Repast\",\"series\":\"WARHAMMER CRIME\",\"raw\":\"Grim Repast\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0600\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The King of the Spoil\",\"series\":\"WARHAMMER CRIME\",\"raw\":\"The King of the Spoil\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0601\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Wraithbone Phoenix\",\"series\":\"WARHAMMER CRIME\",\"raw\":\"The Wraithbone Phoenix\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0602\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Aurelian\",\"series\":\"HORUS HERESY - NOWELE DRUKOWANE\",\"raw\":\"Aurelian\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0603\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Promethean Sun\",\"series\":\"HORUS HERESY - NOWELE DRUKOWANE\",\"raw\":\"Promethean Sun\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0604\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Brotherhood of the Storm\",\"series\":\"HORUS HERESY - NOWELE DRUKOWANE\",\"raw\":\"Brotherhood of the Storm\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0605\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Corax: Soulforge\",\"series\":\"HORUS HERESY - NOWELE DRUKOWANE\",\"raw\":\"Corax: Soulforge\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0606\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Crimson Fist\",\"series\":\"HORUS HERESY - NOWELE DRUKOWANE\",\"raw\":\"The Crimson Fist\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0607\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Serpent Beneath\",\"series\":\"HORUS HERESY - NOWELE DRUKOWANE\",\"raw\":\"The Serpent Beneath\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0608\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Reflection Crack’d\",\"series\":\"HORUS HERESY - NOWELE DRUKOWANE\",\"raw\":\"The Reflection Crack’d\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0609\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Scorched Earth\",\"series\":\"HORUS HERESY - NOWELE DRUKOWANE\",\"raw\":\"Scorched Earth\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0610\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Wolf King\",\"series\":\"HORUS HERESY - NOWELE DRUKOWANE\",\"raw\":\"Wolf King\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0611\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Seventh Serpent\",\"series\":\"HORUS HERESY - NOWELE DRUKOWANE\",\"raw\":\"The Seventh Serpent\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0612\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Weregeld\",\"series\":\"HORUS HERESY - NOWELE DRUKOWANE\",\"raw\":\"Weregeld\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0613\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Honoured\",\"series\":\"HORUS HERESY - NOWELE DRUKOWANE\",\"raw\":\"The Honoured\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0614\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Unburdened\",\"series\":\"HORUS HERESY - NOWELE DRUKOWANE\",\"raw\":\"The Unburdened\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0615\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Shattered and the Soulless\",\"series\":\"HORUS HERESY - OMNIBUSY\",\"raw\":\"The Shattered and the Soulless\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0616\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Heirs of the Emperor\",\"series\":\"HORUS HERESY - OMNIBUSY\",\"raw\":\"Heirs of the Emperor\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0617\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The House of Night and Chain\",\"series\":\"WARHAMMER HORROR\",\"raw\":\"The House of Night and Chain\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0618\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Oubliette\",\"series\":\"WARHAMMER HORROR\",\"raw\":\"The Oubliette\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0619\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Sepulturum\",\"series\":\"WARHAMMER HORROR\",\"raw\":\"Sepulturum\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0620\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Deacon of Wounds\",\"series\":\"WARHAMMER HORROR\",\"raw\":\"The Deacon of Wounds\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0621\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Bookkeeper's Skull\",\"series\":\"WARHAMMER HORROR\",\"raw\":\"The Bookkeeper's Skull\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0622\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Colonel's Monograph\",\"series\":\"WARHAMMER HORROR\",\"raw\":\"The Colonel's Monograph\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0623\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Attack of the Necron\",\"series\":\"WARHAMMER ADVENTURES - WARPED GALAXIES\",\"raw\":\"Attack of the Necron\",\"kind\":\"powieść młodzieżowa\",\"catalogMarker\":\"+\"},{\"id\":\"b0624\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Claws of the Genestealer\",\"series\":\"WARHAMMER ADVENTURES - WARPED GALAXIES\",\"raw\":\"Claws of the Genestealer\",\"kind\":\"powieść młodzieżowa\",\"catalogMarker\":\"+\"},{\"id\":\"b0625\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Secrets of the Tau\",\"series\":\"WARHAMMER ADVENTURES - WARPED GALAXIES\",\"raw\":\"Secrets of the Tau\",\"kind\":\"powieść młodzieżowa\",\"catalogMarker\":\"+\"},{\"id\":\"b0626\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"War of the Orks\",\"series\":\"WARHAMMER ADVENTURES - WARPED GALAXIES\",\"raw\":\"War of the Orks\",\"kind\":\"powieść młodzieżowa\",\"catalogMarker\":\"+\"},{\"id\":\"b0627\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Plague of the Nurglings\",\"series\":\"WARHAMMER ADVENTURES - WARPED GALAXIES\",\"raw\":\"Plague of the Nurglings\",\"kind\":\"powieść młodzieżowa\",\"catalogMarker\":\"+\"},{\"id\":\"b0628\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Tomb of the Necron\",\"series\":\"WARHAMMER ADVENTURES - WARPED GALAXIES\",\"raw\":\"Tomb of the Necron\",\"kind\":\"powieść młodzieżowa\",\"catalogMarker\":\"+\"},{\"id\":\"b0629\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Serpent and the Saint\",\"series\":\"URDESH\",\"raw\":\"The Serpent and the Saint\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0630\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Magister and the Martyr\",\"series\":\"URDESH\",\"raw\":\"The Magister and the Martyr\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0631\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Execution Hour\",\"series\":\"GOTHIC WAR\",\"raw\":\"Execution Hour\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0632\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Shadow Point\",\"series\":\"GOTHIC WAR\",\"raw\":\"Shadow Point\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0633\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Dawn of War\",\"series\":\"DAWN OF WAR\",\"raw\":\"Dawn of War\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0634\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Ascension\",\"series\":\"DAWN OF WAR\",\"raw\":\"Ascension\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0635\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Tempest\",\"series\":\"DAWN OF WAR\",\"raw\":\"Tempest\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0636\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Dawn of War II\",\"series\":\"DAWN OF WAR\",\"raw\":\"Dawn of War II\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0637\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Dawn of War III\",\"series\":\"DAWN OF WAR\",\"raw\":\"Dawn of War III\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0638\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Warrior Brood\",\"series\":\"DEATHWATCH\",\"raw\":\"Warrior Brood\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0639\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Warrior Coven\",\"series\":\"DEATHWATCH\",\"raw\":\"Warrior Coven\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0640\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Daenyathos\",\"series\":\"SOUL DRINKERS\",\"raw\":\"Daenyathos\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0641\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Traitor by Deed\",\"series\":\"SOUL DRINKERS\",\"raw\":\"Traitor by Deed\",\"kind\":\"nowela\",\"catalogMarker\":\"+\"},{\"id\":\"b0642\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Uprising\",\"series\":\"NECROMUNDA\",\"raw\":\"Uprising\",\"kind\":\"powieść\",\"catalogMarker\":\"+\"},{\"id\":\"b0643\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Ahriman: The Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Ahriman: The Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0644\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Path of the Eldar\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Path of the Eldar\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0645\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Path of the Dark Eldar\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Path of the Dark Eldar\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0646\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Adeptus Mechanicus: The Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Adeptus Mechanicus: The Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0647\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Last Chancers\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"The Last Chancers\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0648\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Macharian Crusade\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"The Macharian Crusade\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0649\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Rogue Trader Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Rogue Trader Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0650\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Uriel Ventris Chronicles Vol. 1\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"The Uriel Ventris Chronicles Vol. 1\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0651\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Uriel Ventris Chronicles Vol. 2\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"The Uriel Ventris Chronicles Vol. 2\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0652\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Iron Warriors: The Complete Honsou Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Iron Warriors: The Complete Honsou Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0653\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Salamanders: The Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Salamanders: The Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0654\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Green Tide: An Ork Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"The Green Tide: An Ork Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0655\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Legends of the Waaagh!: An Ork Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Legends of the Waaagh!: An Ork Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0656\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Great Devourer: The Leviathan Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"The Great Devourer: The Leviathan Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0657\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Gothic War\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"The Gothic War\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0658\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Necromunda Omnibus 1\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Necromunda Omnibus 1\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0659\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Necromunda Omnibus 2\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Necromunda Omnibus 2\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0660\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Complete Kal Jerico\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"The Complete Kal Jerico\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0661\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Kal Jerico: The Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Kal Jerico: The Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0662\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Imperial Guard Omnibus: Volume One\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Imperial Guard Omnibus: Volume One\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0663\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Hammer of the Emperor\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Hammer of the Emperor\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0664\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Honour Imperialis\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Honour Imperialis\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0665\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Glory Imperialis\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Glory Imperialis\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0666\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Shield of the Emperor\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Shield of the Emperor\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0667\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Armageddon Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"The Armageddon Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0668\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"War for Armageddon: The Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"War for Armageddon: The Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0669\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Minka Lesk: The Last Whiteshield\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Minka Lesk: The Last Whiteshield\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0670\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Legends of the Wolf: The Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Legends of the Wolf: The Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0671\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Sons of Sanguinius: A Blood Angels Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Sons of Sanguinius: A Blood Angels Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0672\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Lords of Blood: A Blood Angels Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Lords of Blood: A Blood Angels Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0673\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Blackstone Fortress: The Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Blackstone Fortress: The Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0674\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Fabius Bile: The Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Fabius Bile: The Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0675\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Inquisition War\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"The Inquisition War\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0676\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Deathwatch: The Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Deathwatch: The Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0677\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Ciaphas Cain: The Anthology\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Ciaphas Cain: The Anthology\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0678\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Dawn of Fire: Crusade of Vengeance\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Dawn of Fire: Crusade of Vengeance\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0679\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Blood Angels: The Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Blood Angels: The Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0680\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Blood Angels: The Second Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Blood Angels: The Second Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0681\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Blood Ravens: The Dawn of War Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Blood Ravens: The Dawn of War Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0682\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Bastion Wars: The Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Bastion Wars: The Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0683\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Sagas of the Space Wolves: The Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"Sagas of the Space Wolves: The Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0684\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Space Wolves Omnibus\",\"series\":\"KOLEKCJE OMNIBUSOWE\",\"raw\":\"The Space Wolves Omnibus\",\"kind\":\"omnibus\",\"catalogMarker\":\"+\"},{\"id\":\"b0685\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Wicked and the Damned\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"The Wicked and the Damned\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0686\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Maledictions\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Maledictions\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0687\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Invocations\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Invocations\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0688\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Anathemas\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Anathemas\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0689\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Harrowed Paths\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"The Harrowed Paths\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0690\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Accursed\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"The Accursed\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0691\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Resting Places\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"The Resting Places\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0692\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Unholy\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Unholy\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0693\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"On Wings of Blood\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"On Wings of Blood\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0694\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Servants of the Imperium\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Servants of the Imperium\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0695\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"A Rose Watered with Blood and Other Stories\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"A Rose Watered with Blood and Other Stories\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0696\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Lord of the Dark Millennium: The Dan Abnett Collection\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Lord of the Dark Millennium: The Dan Abnett Collection\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0697\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Hammer and the Eagle: Icons of Warhammer\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"The Hammer and the Eagle: Icons of Warhammer\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0698\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Imperium at War\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Imperium at War\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0699\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Warriors and Warlords\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Warriors and Warlords\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0700\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Nexus + Other Stories\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Nexus + Other Stories\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0701\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Book of Martyrs\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"The Book of Martyrs\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0702\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Inferno! Presents: The Inquisition\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Inferno! Presents: The Inquisition\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0703\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Deliverance and Damnation\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Deliverance and Damnation\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0704\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Loyal Sons\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Loyal Sons\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0705\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Successors\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"The Successors\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0706\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Rose at War\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"The Rose at War\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0707\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Only War: Stories from the 41st Millennium\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Only War: Stories from the 41st Millennium\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0708\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Inferno! Presents: The Emperor's Finest\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Inferno! Presents: The Emperor's Finest\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0709\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Renegades of the Long War\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Renegades of the Long War\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0710\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Deathwatch: The Long Vigil\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Deathwatch: The Long Vigil\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0711\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Everliving Legion\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"The Everliving Legion\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0712\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Grey Knights: Sons of Titan\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Grey Knights: Sons of Titan\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0713\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Paragon of Faith and Other Stories\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Paragon of Faith and Other Stories\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0714\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Da Gobbo Collection\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Da Gobbo Collection\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0715\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Soldiers of the Imperium\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Soldiers of the Imperium\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0716\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Ahriman: Exodus\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Ahriman: Exodus\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0717\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Shas'o\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Shas'o\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0718\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"The Tau Empire\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"The Tau Empire\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0719\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Sons of Corax\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Sons of Corax\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0720\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Legends of the Dark Millennium: Ultramarines\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Legends of the Dark Millennium: Ultramarines\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0721\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Black Library Celebration 2023\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Black Library Celebration 2023\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0722\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Black Library Celebration 2024\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Black Library Celebration 2024\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0723\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Black Library Celebration 2025\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Black Library Celebration 2025\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0724\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Black Library Celebration 2026\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Black Library Celebration 2026\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0725\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Knight of Talassar\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Knight of Talassar\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"},{\"id\":\"b0726\",\"pl\":null,\"number\":null,\"uncertain\":false,\"omnibusTitles\":[],\"note\":\"Źródło: katalog papierowy z 12.10.2026. \",\"title\":\"Legends of the Dark Angels\",\"series\":\"ANTOLOGIE I ZBIORY\",\"raw\":\"Legends of the Dark Angels\",\"kind\":\"antologia\",\"catalogMarker\":\"+\"}]");
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
	}
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
async function sourceReaderResponse(url, token, signal, endpoint = "https://nextjs-boilerplate-lb8m.vercel.app/api/source-page", backup) {
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
		endpoint: validate(endpoint),
		token,
		reader: "primary",
		protectionToken: void 0
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
		if (index === 0 && choices.length === 2 && [403, 429].includes(response.status)) {
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
async function fetchLimited(url, parent, readerToken, readerEndpoint, readerBackup) {
	parent?.throwIfAborted();
	const timeout = new URL(url).hostname === "www.vinted.pl" ? 23e3 : 18e3;
	const relayed = await sourceReaderResponse(url, readerToken, parent, readerEndpoint, readerBackup);
	const response = relayed || await fetch(url, {
		headers: {
			Accept: "text/html",
			"User-Agent": "Archiwum40K/1.0 (book price comparison)"
		},
		signal: parent ? AbortSignal.any([parent, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
	});
	if (!response.ok && new URL(url).hostname.endsWith("vinted.pl")) throw Object.assign(vintedFailure(response.status, response.headers.get("Retry-After")), { requestId: relayed?.headers.get("x-vercel-id")?.replace(/[^a-zA-Z0-9:_.-]/g, "").slice(0, 120) });
	if (!response.ok && /^www\.amazon\.(?:pl|de|co\.uk)$/.test(new URL(url).hostname)) throw amazonFailure(response.status, response.headers.get("Retry-After"));
	if (!response.ok) throw Object.assign(/* @__PURE__ */ new Error(response.status === 403 || response.status === 429 ? "blocked HTTP " + response.status : "HTTP " + response.status), {
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
	if (/captcha|verify you are human|Access Denied/.test(text) && text.length < 1e5) {
		if (relayed && !response.headers.has("x-source-fetched-at")) throw readerFailure(response.status);
		if (new URL(url).hostname.endsWith("vinted.pl")) throw vintedFailure(200, null, Date.now(), true);
		if (/^www\.amazon\.(?:pl|de|co\.uk)$/.test(new URL(url).hostname)) throw amazonFailure(200, null, Date.now(), true);
		throw new Error("blocked");
	}
	return text;
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
var SCANNER_VERSION = 46;
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
}, parent, vintedPolicy, marketplacePolicies, readerToken, readerEndpoint, readerBackup) {
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
								return await fetchLimited(url, combined, readerToken, readerEndpoint, sourceReaderBackup);
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
		scannerVersion: 46,
		scope,
		selectedSources,
		offers,
		sources: results.map((r) => r.status)
	};
}
//#endregion
export { SCANNER_VERSION, baseOffer, clean, isBundle, matches, parseEbay, parseOlx, parseWoo, readWithConnectionRetry, readerFailure, readerTraceMessage, runLimited, scanBook, scanErrorDetail, sourceReaderHosts, sourceReaderResponse, vintedOffers };
