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
function reusableVintedCheckpoint(value, book, now = Date.now()) {
	const c = value, terms = [...new Set([book.pl, book.title].filter(Boolean))];
	if (!c || c.version !== 1 || !Number.isFinite(Date.parse(c.startedAt)) || Date.parse(c.startedAt) > now || now - Date.parse(c.startedAt) > 216e5 || !Array.isArray(c.terms) || c.terms.length !== terms.length || !Array.isArray(c.offers)) return null;
	if (!c.terms.every((q, i) => q.term === terms[i] && Number.isInteger(q.pages) && q.pages >= 0 && q.pages <= 10 && typeof q.limited === "boolean" && (q.nextPage === null || Number.isInteger(q.nextPage) && q.nextPage === q.pages + 1 && q.nextPage <= 10))) return null;
	if (!c.terms.some((q) => q.nextPage !== null) || c.offers.some((o) => o.bookId !== book.id || o.source !== "Vinted" || !/^https:\/\/(?:www\.)?vinted\.pl\/items\/\d+/.test(o.url))) return null;
	return c;
}
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
		url: "https://erli.pl/kategoria?phrase=Warcraft",
		reason: "Wyszukiwanie jest dostępne, ale sprawdzone strony produktów blokują odczyt (HTTP 403).",
		alternative: "Wyszukaj tytuł i dodaj cenę konkretnego produktu ręcznie. Sama wyszukiwarka nie potwierdza stanu ani dostępności."
	},
	"SkupSzop": {
		url: "https://skupszop.pl/",
		reason: "Nie potwierdzono działającego czytnika wyników i cen produktów.",
		alternative: "Sprawdź egzemplarz w sklepie i dodaj ofertę ręcznie; „jak nowa” oznacza książkę używaną."
	},
	"Allegro": {
		url: "https://allegro.pl/listing?string=Warcraft+książka",
		reason: "Brak działającego publicznego odczytu cen w tym skanerze.",
		alternative: "Wyszukaj tytuł i dodaj ofertę ręcznie. Allegro Lokalnie ma osobny skaner."
	},
	"Czytam.pl": {
		url: "https://czytam.pl/szukaj?q=Warcraft",
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
		url: "https://antykwariat-gelber.pl/pl/shop/search/1/?search=Warcraft",
		reason: "Nie potwierdzono pełnego automatycznego odczytu danych egzemplarza.",
		alternative: "Sklep udostępnia publiczny formularz wyszukiwania; dodaj cenę i stan ręcznie."
	},
	"Antykwariat Hobbit": {
		url: "https://antykwariathobbit.pl/?post_type=product&s=Warcraft",
		reason: "Nie potwierdzono działającego czytnika ofert i stanu egzemplarza.",
		alternative: "Wyszukiwanie produktów jest dostępne; odczyt ceny i dostępności wymaga dalszej weryfikacji."
	},
	"Ceneo": {
		url: "https://www.ceneo.pl/;szukaj-warcraft",
		reason: "Źródło informacyjne; nie jest objęte automatycznym skanem.",
		alternative: "Porównaj sklepy i sprawdź cenę w sklepie docelowym."
	},
	"World of Books": {
		url: "https://www.worldofbooks.com/en-gb/search?text=Warcraft",
		reason: "Przygotowany link do wyszukiwania; brak zweryfikowanego czytnika.",
		alternative: "Sprawdź wydanie, stan i dostawę do Polski, następnie dodaj ofertę ręcznie."
	}
};
var isManualScanSource = (name) => Object.hasOwn(manualSourceDetails, name);
//#endregion
//#region lib/vinted-policy.ts
function vintedFailure(status, header = null, now = Date.now(), captcha = false) {
	const code = captcha ? "CAPTCHA" : status === 429 ? "HTTP_429" : status === 403 ? "HTTP_403" : "HTTP_" + status;
	const fallback = captcha ? 15 * 6e4 : status === 403 ? 5 * 6e4 : 3e4;
	const seconds = header?.trim() && /^\d+$/.test(header.trim()) ? Number(header) * 1e3 : NaN;
	const parsed = Number.isFinite(seconds) ? now + seconds : header ? Date.parse(header) : NaN;
	const until = Number.isFinite(parsed) ? Math.max(now + fallback, parsed) : now + fallback;
	const reason = captcha ? "Vinted wymaga CAPTCHA." : status === 429 ? "Vinted ograniczył liczbę zapytań (HTTP 429)." : status === 403 ? "Vinted odmówił dostępu (HTTP 403)." : `Vinted zwrócił błąd HTTP ${status}.`;
	return Object.assign(new Error(reason), {
		code,
		retryAfter: new Date(until).toISOString()
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
var antiquarianSearch = (url) => "https://www.google.com/search?q=" + encodeURIComponent("site:" + new URL(url).hostname + " ") + "{q}%20Warcraft%20ksi%C4%85%C5%BCka";
//#endregion
//#region lib/bibliography.json
var bibliography_default = /* @__PURE__ */ JSON.parse("[{\"names\":[\"Day of the Dragon\",\"Dzień smoka\"],\"authors\":[\"Richard A. Knaak\"],\"editions\":[],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-dzien-smoka/\"},{\"names\":[\"Lord of the Clans\",\"Władca klanów\"],\"authors\":[\"Christie Golden\"],\"editions\":[],\"source\":\"https://warcraftbooks.pl/polskie-wydania-ksiazek-warcrafta/\"},{\"names\":[\"The Last Guardian\",\"Ostatni Strażnik\"],\"authors\":[\"Jeff Grubb\"],\"editions\":[],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-ostatni-straznik/\"},{\"names\":[\"The Well of Eternity\",\"Studnia Wieczności\"],\"authors\":[\"Richard A. Knaak\"],\"editions\":[],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-wojna-starozytnych-trylogia/\"},{\"names\":[\"The Demon Soul\",\"Dusza Demona\",\"Demoniczna Dusza\",\"Demoniczna Dusza / Dusza Demona\"],\"authors\":[\"Richard A. Knaak\"],\"editions\":[],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-wojna-starozytnych-trylogia/\"},{\"names\":[\"The Sundering\",\"Rozbicie\"],\"authors\":[\"Richard A. Knaak\"],\"editions\":[],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-wojna-starozytnych-trylogia/\"},{\"names\":[\"Cycle of Hatred\",\"Krąg Nienawiści\"],\"authors\":[\"Keith R. A. DeCandido\"],\"editions\":[],\"source\":\"https://worldofwarcraft.blizzard.com/en-gb/news/9979107/the-library-cycle-of-hatred\"},{\"names\":[\"Rise of the Horde\",\"Narodziny Hordy\"],\"authors\":[\"Christie Golden\"],\"editions\":[],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-narodziny-hordy/\"},{\"names\":[\"Tides of Darkness\",\"Fale ciemności\"],\"authors\":[\"Aaron Rosenberg\"],\"editions\":[],\"source\":\"https://warcraftbooks.pl/polskie-wydania-ksiazek-warcrafta/\"},{\"names\":[\"Beyond the Dark Portal\",\"Przez Mroczny Portal\"],\"authors\":[\"Aaron Rosenberg\",\"Christie Golden\"],\"editions\":[],\"source\":\"https://warcraftbooks.pl/polskie-wydania-ksiazek-warcrafta/\"},{\"names\":[\"Night of the Dragon\",\"Noc smoka\"],\"authors\":[\"Richard A. Knaak\"],\"editions\":[],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-noc-smoka/\"},{\"names\":[\"Arthas: Rise of the Lich King\",\"Arthas: Przebudzenie Króla Lisza\",\"Arthas\"],\"authors\":[\"Christie Golden\"],\"editions\":[],\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\"},{\"names\":[\"Stormrage\",\"Malfurion\"],\"authors\":[\"Richard A. Knaak\"],\"editions\":[],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-malfurion/\"},{\"names\":[\"The Shattering: Prelude to Cataclysm\",\"The Shattering\"],\"authors\":[\"Christie Golden\"],\"editions\":[],\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\"},{\"names\":[\"Thrall: Twilight of the Aspects\"],\"authors\":[\"Christie Golden\"],\"editions\":[],\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\"},{\"names\":[\"Wolfheart\"],\"authors\":[\"Richard A. Knaak\"],\"editions\":[],\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\"},{\"names\":[\"Jaina Proudmoore: Tides of War\",\"Jaina Proudmoore: Wichry wojny\"],\"authors\":[\"Christie Golden\"],\"editions\":[],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-jaina-proudmoore-wichry-wojny/\"},{\"names\":[\"Dawn of the Aspects\"],\"authors\":[\"Richard A. Knaak\"],\"editions\":[],\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\"},{\"names\":[\"Vol’jin: Shadows of the Horde\",\"Vol’jin: Cienie Hordy\"],\"authors\":[\"Michael A. Stackpole\"],\"editions\":[],\"source\":\"https://warcraftbooks.pl/polskie-wydania-ksiazek-warcrafta/\"},{\"names\":[\"War Crimes\",\"Zbrodnie wojenne\"],\"authors\":[\"Christie Golden\"],\"editions\":[],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-zbrodnie-wojenne/\"},{\"names\":[\"Illidan\",\"Illidan\"],\"authors\":[\"William King\"],\"editions\":[],\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\"},{\"names\":[\"Before the Storm\",\"Cisza przed burzą\"],\"authors\":[\"Christie Golden\"],\"editions\":[],\"source\":\"https://warcraftbooks.pl/polskie-wydania-ksiazek-warcrafta/\"},{\"names\":[\"Shadows Rising\",\"Przebudzenie cienia\",\"Przebudzenie Cieni\"],\"authors\":[\"Madeleine Roux\"],\"editions\":[{\"isbn\":\"9788366575158\",\"language\":\"PL\",\"format\":\"Paperback\",\"source\":\"https://sklep.insignis.pl/world-of-warcraft/175-world-of-warcraft-przebudzenie-cienia-9788366575158.html\"}],\"source\":\"https://sklep.insignis.pl/world-of-warcraft/175-world-of-warcraft-przebudzenie-cienia-9788366575158.html\"},{\"names\":[\"Sylvanas\",\"Sylwana\"],\"authors\":[\"Christie Golden\"],\"editions\":[],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-sylwana/\"},{\"names\":[\"War of the Scaleborn\",\"Smocza wojna\"],\"authors\":[\"Courtney Alameda\"],\"editions\":[],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-smocza-wojna/\"},{\"names\":[\"Blood Ties\",\"Więzy krwi\"],\"authors\":[\"Christie Golden\"],\"editions\":[{\"isbn\":\"9781835417522\",\"language\":\"EN\",\"format\":\"Paperback\",\"source\":\"https://titanbooks.com/73034-blood-ties-world-of-warcraft-midnight/\"}],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-wiezy-krwi/\"},{\"names\":[\"Traveler\",\"Traveler. Wędrowiec\"],\"authors\":[\"Greg Weisman\"],\"editions\":[],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-traveler-wedrowiec/\"},{\"names\":[\"Traveler: The Spiral Path\"],\"authors\":[\"Greg Weisman\"],\"editions\":[],\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\"},{\"names\":[\"Traveler: The Shining Blade\"],\"authors\":[\"Madeleine Roux\"],\"editions\":[],\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\"},{\"names\":[\"Chronicle Volume 1\",\"Kronika. Tom 1\",\"Chronicle Vol. 1\",\"Chronicle 1\",\"Kronika Tom I\"],\"authors\":[\"Chris Metzen\",\"Matt Burns\",\"Robert Brooks\"],\"editions\":[{\"isbn\":\"9788366360297\",\"language\":\"PL\",\"format\":\"Hardback\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-kronika-tom/\"}],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-kronika-tom/\"},{\"names\":[\"Chronicle Volume 2\",\"Kronika. Tom 2\",\"Chronicle Vol. 2\",\"Chronicle 2\",\"Kronika Tom II\"],\"authors\":[\"Chris Metzen\",\"Matt Burns\",\"Robert Brooks\"],\"editions\":[],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-kronika-tom-ii/\"},{\"names\":[\"Chronicle Volume 3\",\"Kronika. Tom 3\",\"Chronicle Vol. 3\",\"Chronicle 3\",\"Kronika Tom III\"],\"authors\":[\"Chris Metzen\",\"Matt Burns\",\"Robert Brooks\"],\"editions\":[],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-kronika-tom-iii/\"},{\"names\":[\"Chronicle Volume 4\",\"Chronicle Vol. 4\",\"Chronicle 4\"],\"authors\":[\"Matt Forbeck\",\"Marty Forbeck\"],\"editions\":[{\"isbn\":\"9781506731919\",\"language\":\"EN\",\"format\":\"Hardback\",\"source\":\"https://www.penguinrandomhouse.com/books/739185/world-of-warcraft-chronicle-volume-4-by-written-by-matt-forbeck-written-by-marty-forbeck/\"}],\"source\":\"https://www.penguinrandomhouse.com/books/739185/world-of-warcraft-chronicle-volume-4-by-written-by-matt-forbeck-written-by-marty-forbeck/\"},{\"names\":[\"Exploring Azeroth: The Eastern Kingdoms\",\"Podróż przez Azeroth. Wschodnie Królestwa\"],\"authors\":[\"Christie Golden\"],\"editions\":[],\"source\":\"https://titanbooks.com/70437-world-of-warcraft-exploring-azeroth-the-eastern-kingdoms/\"},{\"names\":[\"Exploring Azeroth: Kalimdor\",\"Podróż przez Azeroth. Kalimdor\"],\"authors\":[\"Sean Copeland\"],\"editions\":[],\"source\":\"https://titanbooks.com/70821-world-of-warcraft-exploring-azeroth-kalimdor/\"},{\"names\":[\"Exploring Azeroth: Northrend\"],\"authors\":[\"Alex Acks\"],\"editions\":[],\"source\":\"https://titanbooks.com/71100-world-of-warcraft-exploring-azeroth-northrend/\"},{\"names\":[\"Exploring Azeroth: Pandaria\"],\"authors\":[\"Alex Acks\"],\"editions\":[],\"source\":\"https://titanbooks.com/71626-world-of-warcraft-exploring-azeroth-pandaria/\"},{\"names\":[\"Exploring Azeroth: Islands and Isles\"],\"authors\":[\"Alex Acks\"],\"editions\":[],\"source\":\"https://titanbooks.com/71937-world-of-warcraft-exploring-azeroth-islands-and-isles/\"},{\"names\":[\"Folk & Fairy Tales of Azeroth\"],\"authors\":[\"Christie Golden\",\"Garth Nix\",\"Catherynne M. Valente\",\"Kami Garcia\"],\"editions\":[],\"source\":\"https://www.simonandschuster.com.au/books/World-of-Warcraft-Folk-Fairy-Tales-of-Azeroth/Christie-Golden/9781789097306\"},{\"names\":[\"The Voices Within\"],\"authors\":[\"Courtney Alameda\",\"Delilah S. Dawson\",\"Christie Golden\",\"Jonathan Maberry\",\"Andrew Robinson\",\"Catherynne M. Valente\"],\"editions\":[{\"isbn\":\"9781835413029\",\"language\":\"EN\",\"format\":\"Hardback\",\"source\":\"https://titanbooks.com/72512-world-of-warcraft-the-voices-within-short-story-collection/\"}],\"source\":\"https://titanbooks.com/72512-world-of-warcraft-the-voices-within-short-story-collection/\"},{\"names\":[\"Crossroads: The War Within Anthology\"],\"authors\":[\"Adam Christopher\",\"L.L. McKinney\",\"Andrew Robinson\"],\"editions\":[{\"isbn\":\"9781835416914\",\"language\":\"EN\",\"format\":\"Hardback\",\"source\":\"https://www.simonandschuster.com.au/books/World-of-Warcraft-Crossroads-The-War-Within-Anthology/Adam-Christopher/9781835416914\"}],\"source\":\"https://www.simonandschuster.com.au/books/World-of-Warcraft-Crossroads-The-War-Within-Anthology/Adam-Christopher/9781835416914\"},{\"names\":[\"Grimoire of the Shadowlands and Beyond\"],\"authors\":[\"Sean Copeland\",\"Steve Danuser\"],\"editions\":[],\"source\":\"https://titanbooks.com/70652-world-of-warcraft-grimoire-of-the-shadowlands-and-beyond/\"},{\"names\":[\"The Dragonflight Codex\"],\"authors\":[\"Sandra Rosner\",\"Doug Walsh\"],\"editions\":[],\"source\":\"https://www.simonandschuster.com/books/World-of-Warcraft-The-Dragonflight-Codex/Sandra-Rosner/WORLD-OF-WARCRAFT/9781647221584\"},{\"names\":[\"The Official Cookbook\"],\"authors\":[\"Chelsea Monroe-Cassel\"],\"editions\":[],\"source\":\"/catalog-source.pdf\"},{\"names\":[\"New Flavors of Azeroth\"],\"authors\":[\"Chelsea Monroe-Cassel\"],\"editions\":[],\"source\":\"https://titanbooks.com/70615-world-of-warcraft-new-flavors-of-azeroth-the-official-cookbook/\"},{\"names\":[\"World of Warcraft Pop-Up Book\",\"Wielka księga pop-up\"],\"authors\":[\"Robert Brooks\",\"Matthew Reinhart\"],\"editions\":[],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-wielka-ksiega-pop-up/\"},{\"names\":[\"Durotan\",\"Durotan. Oficjalny prequel filmu\"],\"authors\":[\"Christie Golden\"],\"editions\":[],\"source\":\"https://warcraftbooks.pl/polskie-wydania-ksiazek-warcrafta/\"},{\"names\":[\"Warcraft: The Official Movie Novelization\",\"Warcraft: Początek. Oficjalna powieść filmu\"],\"authors\":[\"Christie Golden\"],\"editions\":[],\"source\":\"https://warcraftbooks.pl/polskie-wydania-ksiazek-warcrafta/\"},{\"names\":[\"Warcraft Archive\"],\"authors\":[\"Richard A. Knaak\",\"Christie Golden\",\"Jeff Grubb\",\"Chris Metzen\"],\"editions\":[],\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\"},{\"names\":[\"War of the Ancients Archive\",\"Wojna Starożytnych. Trylogia\",\"War of the Ancients\",\"War of the Ancients Trilogy\"],\"authors\":[\"Richard A. Knaak\"],\"editions\":[{\"isbn\":\"9788368053241\",\"language\":\"PL\",\"format\":\"Hardback\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-wojna-starozytnych-trylogia/\"}],\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-wojna-starozytnych-trylogia/\"},{\"names\":[\"Warcraft: Chronicles of War\"],\"authors\":[\"Christie Golden\",\"Jeff Grubb\",\"Aaron Rosenberg\"],\"editions\":[],\"source\":\"/catalog-source.pdf\"},{\"names\":[\"Rise of the Horde & Lord of the Clans: The Illustrated Novels\"],\"authors\":[\"Christie Golden\"],\"editions\":[],\"source\":\"/catalog-source.pdf\"},{\"names\":[\"Exploring Azeroth: The Complete Collection\"],\"authors\":[\"Christie Golden\",\"Sean Copeland\",\"Alex Acks\"],\"editions\":[],\"source\":\"/catalog-source.pdf\"},{\"names\":[\"Elegy & A Good War\",\"Elegia i Słuszna wojna\",\"Elegy and A Good War\",\"Elegia i Sluszna wojna\"],\"authors\":[\"Christie Golden\",\"Robert Brooks\"],\"editions\":[],\"source\":\"https://investor.activision.com/node/31331/pdf\"}]");
//#endregion
//#region lib/book-matching.ts
var normalizeBookText = (s) => s.replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, decimal) => String.fromCodePoint(Math.min(parseInt(hex || decimal, hex ? 16 : 10), 1114111))).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").replace(/[^a-z0-9]+/g, " ").trim().replace(/\b(volume|vol|tom) (iv|iii|ii|i)\b/g, (_, word, roman) => word + " " + {
	i: 1,
	ii: 2,
	iii: 3,
	iv: 4
}[roman]);
var bibliography = bibliography_default;
var knownAuthors = [...new Set(bibliography.flatMap((book) => book.authors))];
var metadataIndex = /* @__PURE__ */ new Map();
var identity = (s) => normalizeBookText(s).replace(/^(?:world of warcraft|warcraft) /, "").trim();
for (const book of bibliography) for (const name of book.names) metadataIndex.set(identity(name), book);
function bookMetadata(names) {
	return names.map((name) => metadataIndex.get(identity(name))).find(Boolean);
}
function bookAuthors(book) {
	return bookMetadata([book.title, book.pl || ""])?.authors || knownAuthors.filter((a) => normalizeBookText(book.raw || "").includes(normalizeBookText(a)));
}
var unrelated = /\b(?:mtg|cd|dvd|vinyl|lego|stl|kindle|steam|battle net key|game key|kod aktywacyjny|karta kolekcjonerska|tcg)\b|blu[ -]?ray|figurki?|miniatures?|funko|ebook|e-book|audiobook|gra planszowa|gra karciana|board game|płyta|plyta|soundtrack|bookmark|poster|dust jacket only|book cover only|action figure|game time|abonament|subskrypcj|koszulka|t shirt|mousepad|podkladka pod mysz|pluszak|plush/i;
var genericTitles = new Set([
	"omnibus",
	"archive",
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
	"warcraft",
	"world of warcraft"
]);
var identityBookNames = (names) => [...new Set([...names, ...bookMetadata(names)?.names || []].map(identity).filter((name) => name && !genericTitles.has(name)))];
var padded = (text) => " " + text + " ";
var authorMatches = (value, author) => {
	const n = normalizeBookText(author), text = padded(normalizeBookText(value));
	const parts = n.split(" "), short = parts[0] + " " + parts.at(-1);
	return text.includes(padded(n)) || text.includes(padded(n.split(" ").reverse().join(" "))) || parts.length > 2 && text.includes(padded(short));
};
var listingIdentity = (title) => {
	let n = padded(normalizeBookText(title));
	for (const author of knownAuthors) n = n.replace(padded(normalizeBookText(author)), " ").replace(padded(normalizeBookText(author).split(" ").reverse().join(" ")), " ");
	return n.replace(/\b(world of warcraft|warcraft|blizzard legends|paperback|hardback|hardcover|softcover|pb|hb|english|angielski|polski|pl|en|ksiazka|book|novel|powiesc|nowa|nowy|new|used|by|insignis|twarda oprawa|miekka oprawa)\b/g, " ").replace(/\s+/g, " ").trim();
};
function classifyPaperBook(title, names, evidence = {}) {
	const text = padded(normalizeBookText(title));
	if (unrelated.test(normalizeBookText(title))) return {
		state: "rejected",
		reason: "Gra, akcesorium, figurka lub wydanie cyfrowe zamiast papierowej książki."
	};
	const identities = identityBookNames(names), meta = bookMetadata(names);
	if (!identities.some((name) => text.includes(padded(name)))) return {
		state: "rejected",
		reason: "Tytuł nie pasuje do książki."
	};
	if (bibliography.some((other) => other !== meta && identityBookNames(other.names).some((candidate) => identities.some((name) => candidate.startsWith(name + " ")) && text.includes(padded(candidate))))) return {
		state: "rejected",
		reason: "Pełny tytuł wskazuje inną książkę z katalogu."
	};
	if (/\b(warhammer|horus heresy|black library|starcraft|diablo|harry potter|star wars)\b/.test(text)) return {
		state: "rejected",
		reason: "Oferta wskazuje inne uniwersum."
	};
	if (/\b(rpg|rulebook|gra komputerowa|komiks|manga|comics?)\b/.test(text)) return {
		state: "rejected",
		reason: "Inny rodzaj publikacji niż książka z katalogu."
	};
	const expected = evidence.authors?.length ? evidence.authors : meta?.authors || [];
	if (evidence.author && expected.length && !expected.some((author) => authorMatches(evidence.author, author) || normalizeBookText(evidence.author).includes(normalizeBookText(author).split(" ").at(-1)))) return {
		state: "rejected",
		reason: "Autor podany przez sklep nie pasuje."
	};
	const present = knownAuthors.filter((author) => authorMatches(title, author));
	if (expected.length && present.length && !present.some((author) => expected.some((wanted) => normalizeBookText(author) === normalizeBookText(wanted)))) return {
		state: "rejected",
		reason: "Inny autor niż szukanej książki."
	};
	if (evidence.isbn && meta?.editions.some((edition) => edition.isbn === evidence.isbn.replace(/[^0-9X]/g, ""))) return {
		state: "matched",
		reason: "Potwierdzony ISBN papierowego wydania."
	};
	if (expected.some((author) => authorMatches(title, author) || evidence.author && authorMatches(evidence.author, author))) return {
		state: "matched",
		reason: "Tytuł i właściwy autor."
	};
	const exact = identities.includes(listingIdentity(title));
	const universe = /\bwarcraft\b/.test(text), paper = /\b(book|books|novel|paperback|hardback|hardcover|ksiazka|ksiazki|powiesc|tom|kronika|chronicle)\b/.test(text);
	const publisher = /insignis|blizzard|pocket books|titan books|del rey|dark horse/i.test(evidence.publisher || "");
	if (exact && (publisher || universe && paper)) return {
		state: "matched",
		reason: "Pełny tytuł i kontekst książki Warcraft."
	};
	return {
		state: "review",
		confidence: universe || publisher ? "likely" : "weak",
		reason: universe || publisher ? "Kontekst Warcraft; autor lub dokładne wydanie wymagają potwierdzenia." : "Sam tytuł nie potwierdza autora ani papierowego wydania."
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
		manualReason: shop.name + ": wyszukaj tytuł i dodaj ofertę ręcznie."
	})),
	{
		key: "insignis",
		name: "Insignis",
		url: "https://sklep.insignis.pl/30-world-of-warcraft",
		search: "https://sklep.insignis.pl/szukaj?controller=search&s={q}"
	},
	{
		key: "poczytaj",
		name: "Poczytaj.pl",
		url: "https://www.poczytaj.pl/",
		search: "https://www.poczytaj.pl/index.php?akcja=pokaz_ksiazki&szukaj={q}"
	},
	{
		key: "tezeusz",
		name: "Tezeusz",
		url: "https://tezeusz.pl/szukaj?cid=3&szukaj=warcraft",
		search: "https://tezeusz.pl/szukaj?cid=3&szukaj={q}",
		mixed: true
	},
	{
		key: "booksale",
		name: "Booksale",
		url: "https://booksale.pl/",
		search: "https://booksale.pl/index.php?do_search=true&search_query={q}"
	},
	{
		key: "smakliter",
		name: "SmakLiter",
		url: "https://smakliter.pl/",
		search: "https://smakliter.pl/?filter={q}"
	},
	{
		key: "megaksiazki",
		name: "Megaksiążki",
		url: "https://www.megaksiazki.pl/",
		search: "https://www.megaksiazki.pl/wyszukiwanie?orderby=position&orderway=desc&search_query={q}",
		englishFirst: true
	},
	{
		key: "czytam",
		name: "Czytam.pl",
		url: "https://czytam.pl/szukaj?q=Warcraft",
		manual: true,
		manualReason: "Wyszukaj tytuł i dodaj cenę konkretnej książki ręcznie."
	},
	{
		key: "lagano",
		name: "Lagano",
		url: "https://lagano.pl/",
		search: "https://lagano.pl/?post_type=product&s={q}"
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
		return (shop.key === "insignis" ? /^\/[^/]+\/\d+-[^/]+\.html$/.test(u.pathname) : patterns[shop.key] ? patterns[shop.key].test(u.pathname) : shop.key === "lagano" ? /^\/ksiazki\/(?:[^/]+\/){2,}[^/]+\/$/.test(u.pathname) : shop.key === "szarlatan" ? /^\/katalog\/[^/]+\/$/.test(u.pathname) : shop.key === "sobieski" ? /^\/[^/]+\.html$/.test(u.pathname) : shop.key === "jaskiniatrolla" ? /^\/[^/]+-p\d+$/.test(u.pathname) : ["gryf", "passioland"].includes(shop.key) ? /^\/products\/[^/]+$/.test(u.pathname) : shop.key === "blackbooks" ? /^\/[^/]+\/\d+-[^/]+\.html$/.test(u.pathname) : ["piekielko", "2d6"].includes(shop.key) ? /^\/pl\/products\/[^/]+-\d+\.html$/.test(u.pathname) : shop.key === "booksale" ? /-p\d+$/.test(u.pathname) : shop.key === "smakliter" ? /,produkt-\d+$/.test(u.pathname) : shop.key === "megaksiazki" ? /^\/(?:[^/]+\/)?\d+-[^/]+\.html$/.test(u.pathname) : shop.key === "hegemon" ? /^\/pl\/[^/]+\/\d+-[^/]+\.html$/.test(u.pathname) : shop.key === "vanaheim" ? /\.html$/.test(u.pathname) : shop.key === "osnowa" ? /^\/pl\/p\/[^/]+\/\d+$/.test(u.pathname) || /^\/(?!pl$|ksiazki$|koszyk$)[^/]+$/.test(u.pathname) : ["mepel", "tezeusz"].includes(shop.key) ? /^\/[^/]+$/.test(u.pathname) && ![
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
		coverage: shop.manualReason || "Otwórz sklep i dodaj cenę papierowej książki ręcznie."
	};
	const listingUrls = [...additionalSearchUrls(b, shop), ...shop.extraUrls || []];
	const urls = /* @__PURE__ */ new Set();
	let listingFailures = 0;
	let listingError;
	let pagePartial = false;
	let pagesRead = 0;
	const pageReasons = [];
	for (const listing of listingUrls) try {
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
var catalog = /* @__PURE__ */ JSON.parse("[{\"id\":\"w0001\",\"title\":\"Day of the Dragon\",\"pl\":\"Dzień smoka\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Day of the Dragon · Dzień smoka · Richard A. Knaak\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-dzien-smoka/\",\"pdfYear\":2001,\"catalogOrder\":2,\"scanEligible\":true,\"omnibusTitles\":[\"Warcraft Archive\"]},{\"id\":\"w0002\",\"title\":\"Lord of the Clans\",\"pl\":\"Władca klanów\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Lord of the Clans · Władca klanów · Christie Golden\",\"uncertain\":false,\"note\":\"Polskie wydanie ISA. Wznowienie lub dostępność należy sprawdzić w ofercie.\",\"kind\":\"powieść\",\"source\":\"https://warcraftbooks.pl/polskie-wydania-ksiazek-warcrafta/\",\"pdfYear\":2001,\"catalogOrder\":3,\"scanEligible\":true,\"omnibusTitles\":[\"Warcraft Archive\",\"Rise of the Horde & Lord of the Clans: The Illustrated Novels\"]},{\"id\":\"w0003\",\"title\":\"The Last Guardian\",\"pl\":\"Ostatni Strażnik\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"The Last Guardian · Ostatni Strażnik · Jeff Grubb\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-ostatni-straznik/\",\"pdfYear\":2001,\"catalogOrder\":4,\"scanEligible\":true,\"omnibusTitles\":[\"Warcraft Archive\"]},{\"id\":\"w0005\",\"title\":\"The Well of Eternity\",\"pl\":\"Studnia Wieczności\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":1,\"raw\":\"The Well of Eternity · Studnia Wieczności · Richard A. Knaak\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-wojna-starozytnych-trylogia/\",\"pdfYear\":2004,\"catalogOrder\":5,\"scanEligible\":true,\"omnibusTitles\":[\"War of the Ancients Archive\"]},{\"id\":\"w0006\",\"title\":\"The Demon Soul\",\"pl\":\"Demoniczna Dusza / Dusza Demona\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":2,\"raw\":\"The Demon Soul · Dusza Demona · Richard A. Knaak\",\"uncertain\":false,\"note\":\"Starsze wydanie: Dusza Demona; w wydaniu zbiorczym: Demoniczna Dusza.\",\"kind\":\"powieść\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-wojna-starozytnych-trylogia/\",\"pdfYear\":2004,\"catalogOrder\":6,\"scanEligible\":true,\"omnibusTitles\":[\"War of the Ancients Archive\"]},{\"id\":\"w0007\",\"title\":\"The Sundering\",\"pl\":\"Rozbicie\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":3,\"raw\":\"The Sundering · Rozbicie · Richard A. Knaak\",\"uncertain\":false,\"note\":\"Trzeci tom Wojny Starożytnych. Nie mylić z The Shattering Christie Golden.\",\"kind\":\"powieść\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-wojna-starozytnych-trylogia/\",\"pdfYear\":2005,\"catalogOrder\":7,\"scanEligible\":true,\"omnibusTitles\":[\"War of the Ancients Archive\"]},{\"id\":\"w0009\",\"title\":\"Cycle of Hatred\",\"pl\":\"Krąg Nienawiści\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Cycle of Hatred · Krąg Nienawiści · Keith R. A. DeCandido\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://worldofwarcraft.blizzard.com/en-gb/news/9979107/the-library-cycle-of-hatred\",\"pdfYear\":2006,\"catalogOrder\":8,\"scanEligible\":true},{\"id\":\"w0008\",\"title\":\"Rise of the Horde\",\"pl\":\"Narodziny Hordy\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Rise of the Horde · Narodziny Hordy · Christie Golden\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-narodziny-hordy/\",\"pdfYear\":2006,\"catalogOrder\":9,\"scanEligible\":true,\"omnibusTitles\":[\"Rise of the Horde & Lord of the Clans: The Illustrated Novels\"]},{\"id\":\"w0010\",\"title\":\"Tides of Darkness\",\"pl\":\"Fale ciemności\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Tides of Darkness · Fale ciemności · Aaron Rosenberg\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://warcraftbooks.pl/polskie-wydania-ksiazek-warcrafta/\",\"pdfYear\":2007,\"catalogOrder\":10,\"scanEligible\":true},{\"id\":\"w0011\",\"title\":\"Beyond the Dark Portal\",\"pl\":\"Przez Mroczny Portal\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Beyond the Dark Portal · Przez Mroczny Portal · Aaron Rosenberg · Christie Golden\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://warcraftbooks.pl/polskie-wydania-ksiazek-warcrafta/\",\"pdfYear\":2008,\"catalogOrder\":11,\"scanEligible\":true},{\"id\":\"w0012\",\"title\":\"Night of the Dragon\",\"pl\":\"Noc smoka\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Night of the Dragon · Noc smoka · Richard A. Knaak\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-noc-smoka/\",\"pdfYear\":2008,\"catalogOrder\":12,\"scanEligible\":true},{\"id\":\"w0013\",\"title\":\"Arthas: Rise of the Lich King\",\"pl\":\"Arthas: Przebudzenie Króla Lisza\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Arthas: Rise of the Lich King · Arthas: Przebudzenie Króla Lisza · Christie Golden\",\"uncertain\":false,\"note\":\"Pełny tytuł i autor odróżniają powieść od innych publikacji o Arthasie.\",\"kind\":\"powieść\",\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\",\"pdfYear\":2009,\"catalogOrder\":13,\"scanEligible\":true},{\"id\":\"w0014\",\"title\":\"Stormrage\",\"pl\":\"Malfurion\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Stormrage · Malfurion · Richard A. Knaak\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-malfurion/\",\"pdfYear\":2010,\"catalogOrder\":14,\"scanEligible\":true},{\"id\":\"w0015\",\"title\":\"The Shattering: Prelude to Cataclysm\",\"pl\":null,\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"The Shattering: Prelude to Cataclysm ·  · Christie Golden\",\"uncertain\":false,\"note\":\"W katalogu EN. Nie jest to Rozbicie Richarda A. Knaaka.\",\"kind\":\"powieść\",\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\",\"pdfYear\":2010,\"catalogOrder\":15,\"scanEligible\":true},{\"id\":\"w0017\",\"title\":\"Thrall: Twilight of the Aspects\",\"pl\":null,\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Thrall: Twilight of the Aspects ·  · Christie Golden\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\",\"pdfYear\":2011,\"catalogOrder\":16,\"scanEligible\":true},{\"id\":\"w0016\",\"title\":\"Wolfheart\",\"pl\":null,\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Wolfheart ·  · Richard A. Knaak\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\",\"pdfYear\":2011,\"catalogOrder\":17,\"scanEligible\":true},{\"id\":\"w0018\",\"title\":\"Jaina Proudmoore: Tides of War\",\"pl\":\"Jaina Proudmoore: Wichry wojny\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Jaina Proudmoore: Tides of War · Jaina Proudmoore: Wichry wojny · Christie Golden\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-jaina-proudmoore-wichry-wojny/\",\"pdfYear\":2012,\"catalogOrder\":18,\"scanEligible\":true},{\"id\":\"w0021\",\"title\":\"Dawn of the Aspects\",\"pl\":null,\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Dawn of the Aspects ·  · Richard A. Knaak\",\"uncertain\":false,\"note\":\"Pełna powieść; pięć części cyfrowych nie jest pięcioma papierowymi tomami.\",\"kind\":\"powieść\",\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\",\"pdfYear\":2013,\"catalogOrder\":19,\"scanEligible\":true},{\"id\":\"w0019\",\"title\":\"Vol’jin: Shadows of the Horde\",\"pl\":\"Vol’jin: Cienie Hordy\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Vol’jin: Shadows of the Horde · Vol’jin: Cienie Hordy · Michael A. Stackpole\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://warcraftbooks.pl/polskie-wydania-ksiazek-warcrafta/\",\"pdfYear\":2013,\"catalogOrder\":20,\"scanEligible\":true},{\"id\":\"w0020\",\"title\":\"War Crimes\",\"pl\":\"Zbrodnie wojenne\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"War Crimes · Zbrodnie wojenne · Christie Golden\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-zbrodnie-wojenne/\",\"pdfYear\":2014,\"catalogOrder\":21,\"scanEligible\":true},{\"id\":\"w0022\",\"title\":\"Illidan\",\"pl\":\"Illidan\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Illidan · Illidan · William King\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\",\"pdfYear\":2016,\"catalogOrder\":22,\"scanEligible\":true},{\"id\":\"w0023\",\"title\":\"Before the Storm\",\"pl\":\"Cisza przed burzą\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Before the Storm · Cisza przed burzą · Christie Golden\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://warcraftbooks.pl/polskie-wydania-ksiazek-warcrafta/\",\"pdfYear\":2018,\"catalogOrder\":23,\"scanEligible\":true},{\"id\":\"w0024\",\"title\":\"Shadows Rising\",\"pl\":\"Przebudzenie cienia\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Shadows Rising · Przebudzenie cienia · Madeleine Roux\",\"uncertain\":false,\"note\":\"W PDF: Przebudzenie Cieni. Oficjalny polski tytuł wydania Insignis: Przebudzenie cienia.\",\"kind\":\"powieść\",\"source\":\"https://sklep.insignis.pl/world-of-warcraft/175-world-of-warcraft-przebudzenie-cienia-9788366575158.html\",\"pdfYear\":2020,\"catalogOrder\":24,\"scanEligible\":true},{\"id\":\"w0025\",\"title\":\"Sylvanas\",\"pl\":\"Sylwana\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Sylvanas · Sylwana · Christie Golden\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-sylwana/\",\"pdfYear\":2022,\"catalogOrder\":25,\"scanEligible\":true},{\"id\":\"w0026\",\"title\":\"War of the Scaleborn\",\"pl\":\"Smocza wojna\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"War of the Scaleborn · Smocza wojna · Courtney Alameda\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-smocza-wojna/\",\"pdfYear\":2023,\"catalogOrder\":26,\"scanEligible\":true},{\"id\":\"w0027\",\"title\":\"Blood Ties\",\"pl\":\"Więzy krwi\",\"series\":\"01 · Główne powieści i dłuższe utwory\",\"number\":null,\"raw\":\"Blood Ties · Więzy krwi · Christie Golden\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-wiezy-krwi/\",\"pdfYear\":2025,\"catalogOrder\":27,\"scanEligible\":true},{\"id\":\"w0039\",\"title\":\"Traveler\",\"pl\":\"Traveler. Wędrowiec\",\"series\":\"02 · Traveler — trylogia przygodowa\",\"number\":1,\"raw\":\"Traveler · Traveler. Wędrowiec · Greg Weisman\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść młodzieżowa\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-traveler-wedrowiec/\",\"pdfYear\":2016,\"catalogOrder\":28,\"scanEligible\":true},{\"id\":\"w0040\",\"title\":\"Traveler: The Spiral Path\",\"pl\":null,\"series\":\"02 · Traveler — trylogia przygodowa\",\"number\":2,\"raw\":\"Traveler: The Spiral Path ·  · Greg Weisman\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść młodzieżowa\",\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\",\"pdfYear\":2018,\"catalogOrder\":29,\"scanEligible\":true},{\"id\":\"w0041\",\"title\":\"Traveler: The Shining Blade\",\"pl\":null,\"series\":\"02 · Traveler — trylogia przygodowa\",\"number\":3,\"raw\":\"Traveler: The Shining Blade ·  · Madeleine Roux\",\"uncertain\":false,\"note\":\"\",\"kind\":\"powieść młodzieżowa\",\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\",\"pdfYear\":2019,\"catalogOrder\":30,\"scanEligible\":true},{\"id\":\"w0030\",\"title\":\"Chronicle Volume 1\",\"pl\":\"Kronika. Tom 1\",\"series\":\"03 · World of Warcraft: Kroniki\",\"number\":1,\"raw\":\"Chronicle Volume 1 · Kronika. Tom 1 · Chris Metzen · Matt Burns · Robert Brooks\",\"uncertain\":false,\"note\":\"\",\"kind\":\"kronika\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-kronika-tom/\",\"pdfYear\":2016,\"catalogOrder\":31,\"scanEligible\":true},{\"id\":\"w0031\",\"title\":\"Chronicle Volume 2\",\"pl\":\"Kronika. Tom 2\",\"series\":\"03 · World of Warcraft: Kroniki\",\"number\":2,\"raw\":\"Chronicle Volume 2 · Kronika. Tom 2 · Chris Metzen · Matt Burns · Robert Brooks\",\"uncertain\":false,\"note\":\"\",\"kind\":\"kronika\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-kronika-tom-ii/\",\"pdfYear\":2017,\"catalogOrder\":32,\"scanEligible\":true},{\"id\":\"w0032\",\"title\":\"Chronicle Volume 3\",\"pl\":\"Kronika. Tom 3\",\"series\":\"03 · World of Warcraft: Kroniki\",\"number\":3,\"raw\":\"Chronicle Volume 3 · Kronika. Tom 3 · Chris Metzen · Matt Burns · Robert Brooks\",\"uncertain\":false,\"note\":\"\",\"kind\":\"kronika\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-kronika-tom-iii/\",\"pdfYear\":2018,\"catalogOrder\":33,\"scanEligible\":true},{\"id\":\"w0033\",\"title\":\"Chronicle Volume 4\",\"pl\":null,\"series\":\"03 · World of Warcraft: Kroniki\",\"number\":4,\"raw\":\"Chronicle Volume 4 ·  · Matt Forbeck · Marty Forbeck\",\"uncertain\":false,\"note\":\"\",\"kind\":\"kronika\",\"source\":\"https://www.penguinrandomhouse.com/books/739185/world-of-warcraft-chronicle-volume-4-by-written-by-matt-forbeck-written-by-marty-forbeck/\",\"pdfYear\":2024,\"catalogOrder\":34,\"scanEligible\":true},{\"id\":\"w0034\",\"title\":\"Exploring Azeroth: The Eastern Kingdoms\",\"pl\":\"Podróż przez Azeroth. Wschodnie Królestwa\",\"series\":\"04 · Exploring Azeroth / Podróż przez Azeroth\",\"number\":1,\"raw\":\"Exploring Azeroth: The Eastern Kingdoms · Podróż przez Azeroth. Wschodnie Królestwa · Christie Golden\",\"uncertain\":false,\"note\":\"\",\"kind\":\"przewodnik\",\"source\":\"https://titanbooks.com/70437-world-of-warcraft-exploring-azeroth-the-eastern-kingdoms/\",\"pdfYear\":2020,\"catalogOrder\":35,\"scanEligible\":true,\"omnibusTitles\":[\"Exploring Azeroth: The Complete Collection\"]},{\"id\":\"w0035\",\"title\":\"Exploring Azeroth: Kalimdor\",\"pl\":\"Podróż przez Azeroth. Kalimdor\",\"series\":\"04 · Exploring Azeroth / Podróż przez Azeroth\",\"number\":2,\"raw\":\"Exploring Azeroth: Kalimdor · Podróż przez Azeroth. Kalimdor · Sean Copeland\",\"uncertain\":false,\"note\":\"\",\"kind\":\"przewodnik\",\"source\":\"https://titanbooks.com/70821-world-of-warcraft-exploring-azeroth-kalimdor/\",\"pdfYear\":2021,\"catalogOrder\":36,\"scanEligible\":true,\"omnibusTitles\":[\"Exploring Azeroth: The Complete Collection\"]},{\"id\":\"w0036\",\"title\":\"Exploring Azeroth: Northrend\",\"pl\":null,\"series\":\"04 · Exploring Azeroth / Podróż przez Azeroth\",\"number\":3,\"raw\":\"Exploring Azeroth: Northrend ·  · Alex Acks\",\"uncertain\":false,\"note\":\"\",\"kind\":\"przewodnik\",\"source\":\"https://titanbooks.com/71100-world-of-warcraft-exploring-azeroth-northrend/\",\"pdfYear\":2022,\"catalogOrder\":37,\"scanEligible\":true,\"omnibusTitles\":[\"Exploring Azeroth: The Complete Collection\"]},{\"id\":\"w0037\",\"title\":\"Exploring Azeroth: Pandaria\",\"pl\":null,\"series\":\"04 · Exploring Azeroth / Podróż przez Azeroth\",\"number\":4,\"raw\":\"Exploring Azeroth: Pandaria ·  · Alex Acks\",\"uncertain\":false,\"note\":\"\",\"kind\":\"przewodnik\",\"source\":\"https://titanbooks.com/71626-world-of-warcraft-exploring-azeroth-pandaria/\",\"pdfYear\":2023,\"catalogOrder\":38,\"scanEligible\":true,\"omnibusTitles\":[\"Exploring Azeroth: The Complete Collection\"]},{\"id\":\"w0038\",\"title\":\"Exploring Azeroth: Islands and Isles\",\"pl\":null,\"series\":\"04 · Exploring Azeroth / Podróż przez Azeroth\",\"number\":5,\"raw\":\"Exploring Azeroth: Islands and Isles ·  · Alex Acks\",\"uncertain\":false,\"note\":\"\",\"kind\":\"przewodnik\",\"source\":\"https://titanbooks.com/71937-world-of-warcraft-exploring-azeroth-islands-and-isles/\",\"pdfYear\":2024,\"catalogOrder\":39,\"scanEligible\":true,\"omnibusTitles\":[\"Exploring Azeroth: The Complete Collection\"]},{\"id\":\"w0049\",\"title\":\"Folk & Fairy Tales of Azeroth\",\"pl\":null,\"series\":\"05 · Antologie opowiadań w wydaniach książkowych\",\"number\":null,\"raw\":\"Folk & Fairy Tales of Azeroth ·  · Christie Golden · Garth Nix · Catherynne M. Valente · Kami Garcia\",\"uncertain\":false,\"note\":\"\",\"kind\":\"antologia\",\"source\":\"https://www.simonandschuster.com.au/books/World-of-Warcraft-Folk-Fairy-Tales-of-Azeroth/Christie-Golden/9781789097306\",\"pdfYear\":2021,\"catalogOrder\":40,\"scanEligible\":true},{\"id\":\"w0042\",\"title\":\"The Voices Within\",\"pl\":null,\"series\":\"05 · Antologie opowiadań w wydaniach książkowych\",\"number\":null,\"raw\":\"The Voices Within ·  · Courtney Alameda · Delilah S. Dawson · Christie Golden · Jonathan Maberry · Andrew Robinson · Catherynne M. Valente\",\"uncertain\":false,\"note\":\"\",\"kind\":\"antologia\",\"source\":\"https://titanbooks.com/72512-world-of-warcraft-the-voices-within-short-story-collection/\",\"pdfYear\":2024,\"catalogOrder\":41,\"scanEligible\":true},{\"id\":\"w0043\",\"title\":\"Crossroads: The War Within Anthology\",\"pl\":null,\"series\":\"05 · Antologie opowiadań w wydaniach książkowych\",\"number\":null,\"raw\":\"Crossroads: The War Within Anthology ·  · Adam Christopher · L.L. McKinney · Andrew Robinson\",\"uncertain\":false,\"note\":\"W PDF podano 2025; wskazane wydanie twardookładkowe Titan Books ma datę 28.04.2026. Rok na liście odtwarzamy według PDF.\",\"kind\":\"antologia\",\"source\":\"https://www.simonandschuster.com.au/books/World-of-Warcraft-Crossroads-The-War-Within-Anthology/Adam-Christopher/9781835416914\",\"pdfYear\":2025,\"catalogOrder\":42,\"scanEligible\":true},{\"id\":\"w0050\",\"title\":\"Grimoire of the Shadowlands and Beyond\",\"pl\":null,\"series\":\"06 · Przewodniki, książki ilustrowane i kucharskie\",\"number\":null,\"raw\":\"Grimoire of the Shadowlands and Beyond ·  · Sean Copeland · Steve Danuser\",\"uncertain\":false,\"note\":\"\",\"kind\":\"przewodnik\",\"source\":\"https://titanbooks.com/70652-world-of-warcraft-grimoire-of-the-shadowlands-and-beyond/\",\"pdfYear\":2021,\"catalogOrder\":43,\"scanEligible\":true},{\"id\":\"w0051\",\"title\":\"The Dragonflight Codex\",\"pl\":null,\"series\":\"06 · Przewodniki, książki ilustrowane i kucharskie\",\"number\":null,\"raw\":\"The Dragonflight Codex ·  · Sandra Rosner · Doug Walsh\",\"uncertain\":false,\"note\":\"\",\"kind\":\"przewodnik\",\"source\":\"https://www.simonandschuster.com/books/World-of-Warcraft-The-Dragonflight-Codex/Sandra-Rosner/WORLD-OF-WARCRAFT/9781647221584\",\"pdfYear\":2023,\"catalogOrder\":44,\"scanEligible\":true},{\"id\":\"w0052\",\"title\":\"The Official Cookbook\",\"pl\":null,\"series\":\"06 · Przewodniki, książki ilustrowane i kucharskie\",\"number\":null,\"raw\":\"The Official Cookbook ·  · Chelsea Monroe-Cassel\",\"uncertain\":false,\"note\":\"\",\"kind\":\"książka kucharska\",\"source\":\"/catalog-source.pdf\",\"pdfYear\":2016,\"catalogOrder\":45,\"scanEligible\":true},{\"id\":\"w0053\",\"title\":\"New Flavors of Azeroth\",\"pl\":null,\"series\":\"06 · Przewodniki, książki ilustrowane i kucharskie\",\"number\":null,\"raw\":\"New Flavors of Azeroth ·  · Chelsea Monroe-Cassel\",\"uncertain\":false,\"note\":\"\",\"kind\":\"książka kucharska\",\"source\":\"https://titanbooks.com/70615-world-of-warcraft-new-flavors-of-azeroth-the-official-cookbook/\",\"pdfYear\":2021,\"catalogOrder\":46,\"scanEligible\":true},{\"id\":\"w0047\",\"title\":\"World of Warcraft Pop-Up Book\",\"pl\":\"Wielka księga pop-up\",\"series\":\"06 · Przewodniki, książki ilustrowane i kucharskie\",\"number\":null,\"raw\":\"World of Warcraft Pop-Up Book · Wielka księga pop-up · Robert Brooks · Matthew Reinhart\",\"uncertain\":false,\"note\":\"\",\"kind\":\"album\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-wielka-ksiega-pop-up/\",\"pdfYear\":2019,\"catalogOrder\":47,\"scanEligible\":true},{\"id\":\"w0044\",\"title\":\"Durotan\",\"pl\":\"Durotan. Oficjalny prequel filmu\",\"series\":\"07 · Powieści powiązane z filmem Warcraft\",\"number\":null,\"raw\":\"Durotan · Durotan. Oficjalny prequel filmu · Christie Golden\",\"uncertain\":false,\"note\":\"Prequel filmu; osobna ciągłość fabularna względem gier.\",\"kind\":\"powieść filmowa\",\"source\":\"https://warcraftbooks.pl/polskie-wydania-ksiazek-warcrafta/\",\"pdfYear\":2016,\"catalogOrder\":48,\"scanEligible\":true},{\"id\":\"w0045\",\"title\":\"Warcraft: The Official Movie Novelization\",\"pl\":\"Warcraft: Początek. Oficjalna powieść filmu\",\"series\":\"07 · Powieści powiązane z filmem Warcraft\",\"number\":null,\"raw\":\"Warcraft: The Official Movie Novelization · Warcraft: Początek. Oficjalna powieść filmu · Christie Golden\",\"uncertain\":false,\"note\":\"Powieść towarzysząca filmowi; osobna ciągłość fabularna względem gier.\",\"kind\":\"powieść filmowa\",\"source\":\"https://warcraftbooks.pl/polskie-wydania-ksiazek-warcrafta/\",\"pdfYear\":2016,\"catalogOrder\":49,\"scanEligible\":true},{\"id\":\"w0029\",\"title\":\"Warcraft Archive\",\"pl\":null,\"series\":\"08 · Wydania zbiorcze i kolekcjonerskie\",\"number\":null,\"raw\":\"Warcraft Archive ·  · Richard A. Knaak · Christie Golden · Jeff Grubb · Chris Metzen\",\"uncertain\":false,\"note\":\"Drukowane wydanie zawiera także Of Blood and Honor; nowela nie jest osobną fizyczną pozycją kolekcji.\",\"kind\":\"omnibus\",\"source\":\"https://worldofwarcraft.blizzard.com/en-us/media\",\"contents\":[\"Day of the Dragon\",\"Lord of the Clans\",\"The Last Guardian\",\"Of Blood and Honor\"],\"pdfYear\":2006,\"catalogOrder\":50,\"scanEligible\":true},{\"id\":\"w0028\",\"title\":\"War of the Ancients Archive\",\"pl\":\"Wojna Starożytnych. Trylogia\",\"series\":\"08 · Wydania zbiorcze i kolekcjonerskie\",\"number\":null,\"raw\":\"War of the Ancients Archive · Wojna Starożytnych. Trylogia · Richard A. Knaak\",\"uncertain\":false,\"note\":\"Wydanie zbiorcze trzech powieści, osobny rekord kolekcji.\",\"kind\":\"omnibus\",\"source\":\"https://www.insignis.pl/ksiazki/world-of-warcraft-wojna-starozytnych-trylogia/\",\"contents\":[\"The Well of Eternity\",\"The Demon Soul\",\"The Sundering\"],\"pdfYear\":2007,\"catalogOrder\":51,\"scanEligible\":true},{\"id\":\"w0054\",\"title\":\"Warcraft: Chronicles of War\",\"pl\":null,\"series\":\"08 · Wydania zbiorcze i kolekcjonerskie\",\"number\":null,\"raw\":\"Warcraft: Chronicles of War ·  · Christie Golden · Jeff Grubb · Aaron Rosenberg\",\"uncertain\":false,\"note\":\"Wydanie zbiorcze wcześniejszych powieści; nie jest nową odrębną historią.\",\"kind\":\"omnibus\",\"source\":\"/catalog-source.pdf\",\"pdfYear\":2010,\"catalogOrder\":52,\"scanEligible\":true},{\"id\":\"w0055\",\"title\":\"Rise of the Horde & Lord of the Clans: The Illustrated Novels\",\"pl\":null,\"series\":\"08 · Wydania zbiorcze i kolekcjonerskie\",\"number\":null,\"raw\":\"Rise of the Horde & Lord of the Clans: The Illustrated Novels ·  · Christie Golden\",\"uncertain\":false,\"note\":\"\",\"kind\":\"omnibus\",\"source\":\"/catalog-source.pdf\",\"contents\":[\"Rise of the Horde\",\"Lord of the Clans\"],\"pdfYear\":2020,\"catalogOrder\":53,\"scanEligible\":true},{\"id\":\"w0056\",\"title\":\"Exploring Azeroth: The Complete Collection\",\"pl\":null,\"series\":\"08 · Wydania zbiorcze i kolekcjonerskie\",\"number\":null,\"raw\":\"Exploring Azeroth: The Complete Collection ·  · Christie Golden · Sean Copeland · Alex Acks\",\"uncertain\":false,\"note\":\"Zestaw pięciu przewodników. Status zestawu jest osobny od statusów tomów.\",\"kind\":\"omnibus\",\"source\":\"/catalog-source.pdf\",\"contents\":[\"Exploring Azeroth: The Eastern Kingdoms\",\"Exploring Azeroth: Kalimdor\",\"Exploring Azeroth: Northrend\",\"Exploring Azeroth: Pandaria\",\"Exploring Azeroth: Islands and Isles\"],\"pdfYear\":2024,\"catalogOrder\":54,\"scanEligible\":true},{\"id\":\"w0063\",\"title\":\"Elegy & A Good War\",\"pl\":\"Elegia i Słuszna wojna\",\"series\":\"08 · Wydania zbiorcze i kolekcjonerskie\",\"number\":null,\"raw\":\"Elegy & A Good War · Elegia i Słuszna wojna · Christie Golden · Robert Brooks\",\"uncertain\":false,\"note\":\"Jeden wspólny tom twardookładkowy z edycji kolekcjonerskiej Battle for Azeroth. Dwie nowele, jedna fizyczna książka.\",\"kind\":\"omnibus\",\"source\":\"https://investor.activision.com/node/31331/pdf\",\"contents\":[\"Elegy\",\"A Good War\"],\"pdfYear\":2018,\"catalogOrder\":61,\"scanEligible\":true}]");
var norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").replace(/[^a-z0-9]+/g, " ").trim();
var vintedSearchUrl = (title) => "https://www.vinted.pl/catalog/2312-books?search_text=" + encodeURIComponent(title);
var searchLinks = (b) => [
	{
		name: "OLX",
		url: "https://www.olx.pl/muzyka-edukacja/ksiazki/q-" + encodeURIComponent(norm(b.pl || b.title).replace(/ /g, "-")) + "/"
	},
	{
		name: "Allegro",
		url: "https://allegro.pl/listing?string=" + encodeURIComponent((b.pl || b.title) + " książka")
	},
	{
		name: "Vinted",
		url: vintedSearchUrl(b.pl || b.title)
	},
	{
		name: "Insignis",
		url: "https://sklep.insignis.pl/szukaj?controller=search&s=" + encodeURIComponent(b.pl || b.title)
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
var knownBookstorePages = {};
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
async function sourceReaderResponse(url, token, signal, endpoint) {
	if (!endpoint || !token || token.length < 32) return null;
	const target = new URL(url), source = Object.entries(sourceReaderHosts).find(([, host]) => target.hostname === host || target.hostname === "www." + host)?.[0];
	if (!source) return null;
	if (target.protocol !== "https:" || target.username || target.password || target.port) throw Error("Nieprawidłowy adres źródła.");
	const readerUrl = new URL(endpoint);
	if (readerUrl.protocol !== "https:" || readerUrl.username || readerUrl.password || readerUrl.port || readerUrl.hash || readerUrl.search) throw Error("Nieprawidłowa konfiguracja serwera odczytu.");
	const response = await fetch(readerUrl.href, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer " + token
		},
		body: JSON.stringify({
			source,
			url
		}),
		signal,
		redirect: "manual",
		cache: "no-store"
	});
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel();
		throw Error("Serwer odczytu zwrócił nieoczekiwane przekierowanie.");
	}
	return response;
}
async function fetchLimited(url, parent, readerToken, readerEndpoint) {
	parent?.throwIfAborted();
	const response = await sourceReaderResponse(url, readerToken, parent, readerEndpoint) || await fetch(url, {
		headers: {
			Accept: "text/html",
			"User-Agent": "ArchiwumWarcraft/1.0 (book price comparison)"
		},
		signal: parent ? AbortSignal.any([parent, AbortSignal.timeout(18e3)]) : AbortSignal.timeout(18e3)
	});
	if (!response.ok && new URL(url).hostname.endsWith("vinted.pl")) throw vintedFailure(response.status, response.headers.get("Retry-After"));
	if (!response.ok && /^www\.amazon\.(?:pl|de|co\.uk)$/.test(new URL(url).hostname)) throw amazonFailure(response.status, response.headers.get("Retry-After"));
	if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? "blocked HTTP " + response.status : "HTTP " + response.status);
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
var SCANNER_VERSION = 5;
var sourcePriority = {
	"Vinted": 10,
	"Booksale": 3,
	"Megaksiążki": 2,
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
async function vintedOffers(b, checked, read, budget = 9e4, store, maxPages = Infinity) {
	const terms = Array.from(new Set([b.pl, b.title].filter(Boolean)));
	const saved = store ? reusableVintedCheckpoint(await store.load(), b) : null;
	const startedAt = saved?.startedAt || checked;
	const queue = terms.map((term, i) => ({
		term,
		nextPage: saved ? saved.terms[i].nextPage : 1,
		pages: saved?.terms[i].pages || 0,
		limited: saved?.terms[i].limited || false,
		contents: /* @__PURE__ */ new Set(),
		failed: false
	}));
	const offers = [...saved?.offers || []];
	let successes = 0, error;
	const unique = () => Array.from(new Map(offers.map((o) => [o.url.match(/\/items\/(\d+)/)?.[1] || o.id, o])).values());
	const checkpoint = () => ({
		version: 1,
		startedAt,
		updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		terms: queue.map(({ term, nextPage, pages, limited }) => ({
			term,
			nextPage,
			pages,
			limited
		})),
		offers: unique()
	});
	const until = Date.now() + Math.max(1, budget - Math.min(3e3, budget * .2));
	while (successes < maxPages && queue.some((q) => q.nextPage !== null && !q.failed)) {
		for (const q of [...queue].sort((a, b) => a.pages - b.pages)) {
			if (successes >= maxPages) break;
			if (q.nextPage === null || q.failed) continue;
			const remaining = until - Date.now();
			if (remaining <= 0) break;
			try {
				const url = new URL(vintedSearchUrl(q.term));
				if (q.nextPage > 1) url.searchParams.set("page", String(q.nextPage));
				const html = await withDeadline((signal) => read(url.href, signal), Math.min(25e3, remaining), "Przekroczono czas strony Vinted.");
				if (q.contents.has(html)) throw Error("Powtórzona treść strony wyników.");
				const parsed = parseVinted(html, b, checked), next = nextSearchPage(html, url.href);
				const nextPage = next ? Number(new URL(next).searchParams.get("page")) : null;
				if (nextPage !== null && (!Number.isInteger(nextPage) || nextPage !== q.nextPage + 1)) throw Error("Nieprawidłowa kolejna strona Vinted.");
				q.contents.add(html);
				offers.push(...parsed);
				successes++;
				q.pages++;
				q.limited = nextPage !== null && nextPage > 10;
				q.nextPage = q.limited ? null : nextPage;
				await store?.save(checkpoint());
			} catch (e) {
				error = e;
				q.failed = true;
				if (error.retryAfter) break;
			}
		}
		if (error?.retryAfter || Date.now() >= until) break;
	}
	const pending = queue.some((q) => q.nextPage !== null), partial = pending || queue.some((q) => q.limited) || !!error;
	if (!successes && !saved) throw error || /* @__PURE__ */ new Error("Nie odczytano wyników Vinted.");
	return {
		offers: unique(),
		partial,
		...pending || error ? { retryAfter: error?.retryAfter || new Date(Date.now() + (successes >= maxPages ? 1500 : 3e4)).toISOString() } : {},
		coverage: "Vinted: kategoria Książki; tytuły PL/EN sprawdzane naprzemiennie. " + (saved ? "Wznowiono zapisany odczyt. " : "") + (Number.isFinite(maxPages) ? "Szybki przegląd. " : "") + queue.map((q) => `„${q.term}”: ${q.pages} stron (limit 10)` + (q.nextPage !== null ? `; do wznowienia strona ${q.nextPage}` : "") + ".").join(" ") + (pending ? " Zapisane oferty i postęp stron pozostają do kolejnej próby." : queue.some((q) => q.limited) ? " Osiągnięto limit stron." : "") + (error ? " " + error.message : "") + " Brak dopasowań nie potwierdza braku książki w całym serwisie."
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
async function scanBook(b, cooldowns = {}, scope = "all", selectedSources, budgets = {
	source: 35e3,
	book: 12e4,
	vinted: 9e4
}, parent, vintedPolicy, marketplacePolicies, readerToken, readerEndpoint, vintedCheckpoint) {
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
			source: "OLX",
			url: links[0].url,
			run: async (read) => marketplacePages(links[0].url, read, (html) => parseOlx(html, b, checked))
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
			url: links[2].url,
			run: (read) => vintedOffers(b, checked, read, budgets.vinted || 9e4, vintedCheckpoint, budgets.vintedPagesPerPass)
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
							requestCount++;
							return await readWithConnectionRetry(() => fetchLimited(url, combined, readerToken, readerEndpoint), combined, j.source === "Vinted");
						} catch (e) {
							if (policy) {
								const failure = e;
								if (!combined.aborted && !failure.retryAfter && failure.name !== "AbortError") Object.assign(failure, { retryAfter: new Date(Date.now() + 3e4).toISOString() });
								if (!combined.aborted) await policy.onFailure(failure);
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
						...vintedRetry ? { retryAfter: vintedRetry } : {},
						...amazonRetry ? { retryAfter: amazonRetry } : {},
						message: amazonRetry ? message + " Odczyt czasowo wstrzymany. Kolejna próba po: " + new Date(amazonRetry).toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw" }) + ". Poprzednie ceny pozostają z datą ostatniego odczytu; błąd nie oznacza braku ofert." : vintedRetry ? message + " Odczyt wstrzymany do wskazanego czasu. To nie oznacza braku ofert." : timedOut ? "Przekroczono czas odczytu. Źródło nie zostało w pełni sprawdzone; to nie oznacza braku ofert." : blocked ? "Serwis blokuje automatyczny odczyt. Otwórz wyszukiwanie." : "Nie udało się odczytać źródła. Przyczyna: " + scanErrorDetail(e) + ". Błąd nie oznacza braku ofert."
					}
				};
			}
		})();
		return {
			...result,
			status: {
				...result.status,
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
		scannerVersion: 5,
		scope,
		selectedSources,
		offers,
		sources: results.map((r) => r.status)
	};
}
//#endregion
export { SCANNER_VERSION, baseOffer, clean, isBundle, matches, parseEbay, parseOlx, readWithConnectionRetry, runLimited, scanBook, scanErrorDetail, sourceReaderHosts, sourceReaderResponse, vintedOffers };
