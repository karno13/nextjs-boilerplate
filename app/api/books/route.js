import { BOOKS } from "../../../lib/books.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/140.0.0.0 Safari/537.36",

  "Accept-Language":
    "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7",

  Accept:
    "text/html,application/xhtml+xml," +
    "application/xml;q=0.9,*/*;q=0.8",
};

/*
  ============================================
  FUNKCJE WSPÓLNE
  ============================================
*/

function cleanText(value = "") {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanOfferTitle(value = "") {
  let text = cleanText(value);

  const stopWords = [
    "Gatunek:",
    "Język publikacji:",
    "Okładka:",
    "Tytuł:",
    "Kup teraz",
    "Licytacja",
    "Sprzedający:",
  ];

  for (const word of stopWords) {
    const index = text.indexOf(word);

    if (index > 0) {
      text = text.slice(0, index);
    }
  }

  return text.trim();
}

function normalize(value = "") {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePrice(value) {
  if (!value) return null;

  const match = value.match(
    /(\d[\d\s]*(?:[,.]\d{1,2})?)/
  );

  if (!match) return null;

  const number = Number(
    match[1]
      .replace(/\s/g, "")
      .replace(",", ".")
  );

  return Number.isFinite(number)
    ? number
    : null;
}

function scoreMatch(wanted, found) {
  const a = normalize(wanted);
  const b = normalize(found);

  if (!a || !b) return 0;

  if (a === b) {
    return 100;
  }

  if (b.includes(a)) {
    return 95;
  }

  const wantedWords = a
    .split(" ")
    .filter((word) => word.length > 2);

  if (!wantedWords.length) {
    return 0;
  }

  const foundWords =
    new Set(b.split(" "));

  let matches = 0;

  for (const word of wantedWords) {
    if (foundWords.has(word)) {
      matches++;
    }
  }

  return (
    matches / wantedWords.length
  ) * 100;
}

function bestBookScore(book, title) {
  return Math.max(
    scoreMatch(
      book.originalTitle,
      title
    ),

    book.polishTitle
      ? scoreMatch(
          book.polishTitle,
          title
        )
      : 0
  );
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    next: {
      revalidate: 3600,
    },

    headers: HEADERS,

    redirect: "follow",
  });

  if (response.status === 429) {
    throw new Error("RATE_LIMITED");
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  return await response.text();
}

function cheapest(offers) {
  return (
    offers
      .filter(
        (offer) =>
          offer.price != null
      )
      .sort(
        (a, b) =>
          a.price - b.price
      )[0] || null
  );
}

/*
  ============================================
  ALLEGRO LOKALNIE
  ============================================
*/

function allegroOfferScore(
  book,
  result
) {
  const text =
    normalize(result.title);

  let score =
    bestBookScore(
      book,
      result.title
    );

  const bonusWords = [
    "warhammer",
    "black library",
    "horus heresy",
    "40k",
    "40000",
    "games workshop",
    "ksiazka",
    "powiesc",
  ];

  for (const word of bonusWords) {
    if (
      text.includes(
        normalize(word)
      )
    ) {
      score += 10;
    }
  }

  const badWords = [
    "banknot",
    "banknoty",
    "moneta",
    "monety",
    "booster",
    "boostery",
    "pokemon",
    "lego",
    "koszulka",
    "plakat",
    "kubek",
    "brelok",
    "naklejka",
    "puzzle",
    "figurka",
    "figurki",
    "miniatura",
  ];

  for (const word of badWords) {
    if (
      text.includes(
        normalize(word)
      )
    ) {
      score -= 60;
    }
  }

  return Math.round(score);
}

async function searchLokalnie(query) {
  const url =
    "https://allegrolokalnie.pl/oferty/q/" +
    encodeURIComponent(query);

  const response = await fetch(url, {
    next: {
      revalidate: 3600,
    },

    headers: HEADERS,
  });

  if (response.status === 429) {
    throw new Error(
      "RATE_LIMITED"
    );
  }

  if (!response.ok) {
    throw new Error(
      `Allegro Lokalnie HTTP ${response.status}`
    );
  }

  const html =
    await response.text();

  const results = [];

  const linkRegex =
    /href=["'](\/oferta\/[^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while (
    (match =
      linkRegex.exec(html)) !== null
  ) {
    const relativeUrl =
      match[1];

    const anchorHtml =
      match[2];

    const fullText =
      cleanText(anchorHtml);

    let priceMatch =
      fullText.match(
        /(?:Kup teraz|Licytacja)?\s*(\d[\d\s]*(?:[,.]\d{2})?)\s*zł/i
      );

    const around =
      html.slice(
        Math.max(
          0,
          match.index - 2500
        ),

        Math.min(
          html.length,
          match.index +
            match[0].length +
            3500
        )
      );

    if (!priceMatch) {
      priceMatch =
        around.match(
          /(\d[\d\s]*(?:[,.]\d{2})?)\s*zł/i
        );
    }

    const title =
      cleanOfferTitle(
        anchorHtml
      );

    if (
      !title ||
      title.length < 3
    ) {
      continue;
    }

    const price =
      priceMatch?.[1]
        ? parsePrice(
            priceMatch[1]
          )
        : null;

    const imageMatch =
      around.match(
        /<img[^>]+(?:src|data-src)=["']([^"']+)["']/i
      );

    results.push({
      source:
        "allegro_lokalnie",

      condition:
        "used_or_unknown",

      title,

      price,

      rawPrice:
        priceMatch?.[0] ||
        null,

      currency: "PLN",

      image:
        imageMatch?.[1] ||
        null,

      url:
        "https://allegrolokalnie.pl" +
        relativeUrl,
    });

    if (
      results.length >= 50
    ) {
      break;
    }
  }

  const unique =
    new Map();

  for (const item of results) {
    if (
      !unique.has(item.url)
    ) {
      unique.set(
        item.url,
        item
      );
    }
  }

  return [
    ...unique.values(),
  ];
}

/*
  ============================================
  HEGEMON
  ============================================
*/

function parseHegemonPage(html) {
  const products = [];

  const titleRegex =
    /<h2[^>]*class=["'][^"']*product-title[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while (
    (match =
      titleRegex.exec(html)) !== null
  ) {
    const url =
      match[1];

    const title =
      cleanText(
        match[2]
      );

    if (!title) {
      continue;
    }

    const around =
      html.slice(
        Math.max(
          0,
          match.index - 1800
        ),

        Math.min(
          html.length,
          match.index + 3500
        )
      );

    const priceMatch =
      around.match(
        /(\d[\d\s]*[,.]\d{2})\s*(?:&nbsp;|&#160;|\s|\u00a0)*zł/i
      );

    const stockMatch =
      around.match(
        /Na stanie\s*:?\s*(\d+)\s*szt/i
      );

    const imageMatch =
      around.match(
        /<img[^>]+(?:src|data-src)=["']([^"']+)["']/i
      );

    const price =
      priceMatch
        ? parsePrice(
            priceMatch[1]
          )
        : null;

    const stock =
      stockMatch
        ? Number(
            stockMatch[1]
          )
        : null;

    products.push({
      source: "hegemon",

      condition: "new",

      title,

      price,

      rawPrice:
        priceMatch?.[0] ||
        null,

      currency: "PLN",

      stock,

      available:
        stock == null
          ? null
          : stock > 0,

      image:
        imageMatch?.[1] ||
        null,

      url,
    });
  }

  return products;
}

function getHegemonPageCount(html) {
  const patterns = [
    /Jest\s+(\d+)\s+produkt/i,
    /(\d+)\s+produktów/i,
    /(\d+)\s+produkty/i,
  ];

  for (const pattern of patterns) {
    const match =
      html.match(pattern);

    if (match) {
      const total =
        Number(match[1]);

      if (
        Number.isFinite(total) &&
        total > 0
      ) {
        return Math.ceil(
          total / 36
        );
      }
    }
  }

  return 12;
}

async function getHegemonCatalog() {
  const base =
    "https://hegemonshop.com/pl/314-black-library";

  const firstHtml =
    await fetchHtml(base);

  const pageCount =
    getHegemonPageCount(
      firstHtml
    );

  const all = [
    ...parseHegemonPage(
      firstHtml
    ),
  ];

  for (
    let page = 2;
    page <= pageCount;
    page++
  ) {
    try {
      const html =
        await fetchHtml(
          `${base}?page=${page}`
        );

      all.push(
        ...parseHegemonPage(
          html
        )
      );

      await sleep(120);

    } catch (error) {
      console.error(
        `Hegemon ${page}:`,
        error.message
      );
    }
  }

  const unique =
    new Map();

  for (const item of all) {
    const key =
      item.url ||
      normalize(item.title);

    if (!unique.has(key)) {
      unique.set(
        key,
        item
      );
    }
  }

  return [
    ...unique.values(),
  ];
}

/*
  ============================================
  SKUPSZOP
  ============================================

  Zamiast wyszukiwać 555 razy,
  pobieramy katalogi wydawnictw:

  - Black Library
  - Copernicus Center Press

  SkupSzop ma oba katalogi jako normalne
  strony HTML.
*/

function detectSkupCondition(text) {
  const normalized =
    normalize(text);

  if (
    normalized.includes("nowa")
  ) {
    return "new";
  }

  if (
    normalized.includes(
      "jak nowa"
    )
  ) {
    return "like_new";
  }

  if (
    normalized.includes(
      "bardzo dobry"
    )
  ) {
    return "very_good";
  }

  if (
    normalized.includes("dobry")
  ) {
    return "good";
  }

  return "unknown";
}

function parseSkupPage(html) {
  const products = [];

  /*
    Strony produktów SkupSzopu są
    bezpośrednio pod domeną:

    https://skupszop.pl/nazwa-produktu-ISBN
  */

  const linkRegex =
    /<a[^>]+href=["'](https?:\/\/skupszop\.pl\/[^"'?#]+|\/[^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while (
    (match =
      linkRegex.exec(html)) !== null
  ) {
    let url =
      match[1];

    if (
      url.startsWith("/")
    ) {
      url =
        "https://skupszop.pl" +
        url;
    }

    /*
      Ignorujemy strony systemowe.
    */

    const path =
      url
        .replace(
          "https://skupszop.pl",
          ""
        )
        .toLowerCase();

    const excludedPrefixes = [
      "/autor/",
      "/wydawnictwo/",
      "/kategoria/",
      "/seria/",
      "/tag/",
      "/blog",
      "/pomoc",
      "/kontakt",
      "/sprzedaj",
      "/koszyk",
      "/login",
      "/mapa",
      "/wszystkie-",
      "/regulamin",
    ];

    if (
      excludedPrefixes.some(
        (prefix) =>
          path.startsWith(prefix)
      )
    ) {
      continue;
    }

    const around =
      html.slice(
        Math.max(
          0,
          match.index - 1600
        ),

        Math.min(
          html.length,
          match.index +
            match[0].length +
            3000
        )
      );

    let title =
      cleanText(
        match[2]
      );

    /*
      Link może zawierać obraz.
    */

    if (
      !title ||
      title.length < 3
    ) {
      const altMatch =
        match[0].match(
          /alt=["']([^"']+)["']/i
        );

      if (altMatch) {
        title =
          cleanText(
            altMatch[1]
          );
      }
    }

    /*
      Ewentualnie title="".
    */

    if (
      !title ||
      title.length < 3
    ) {
      const titleMatch =
        match[0].match(
          /title=["']([^"']+)["']/i
        );

      if (titleMatch) {
        title =
          cleanText(
            titleMatch[1]
          );
      }
    }

    if (
      !title ||
      title.length < 3
    ) {
      continue;
    }

    /*
      Odrzucamy typowe elementy menu.
    */

    const normalizedTitle =
      normalize(title);

    const badTitles = [
      "dodaj do koszyka",
      "dodano do koszyka",
      "pokaz szczegoly",
      "szczegoly",
      "dowiedz sie wiecej",
      "powiadom mnie",
      "zobacz wszystkie ksiazki",
    ];

    if (
      badTitles.some(
        (bad) =>
          normalizedTitle === bad
      )
    ) {
      continue;
    }

    /*
      Cena.
    */

    const priceMatches =
      [
        ...around.matchAll(
          /(\d[\d\s]*[,.]\d{2})\s*zł/gi
        ),
      ];

    let price = null;
    let rawPrice = null;

    /*
      Bierzemy pierwszą rozsądną cenę.
    */

    for (
      const priceMatch
      of priceMatches
    ) {
      const parsed =
        parsePrice(
          priceMatch[1]
        );

      if (
        parsed != null &&
        parsed > 1 &&
        parsed < 1000
      ) {
        price =
          parsed;

        rawPrice =
          priceMatch[0];

        break;
      }
    }

    /*
      Stan książki.
    */

    const condition =
      detectSkupCondition(
        cleanText(around)
      );

    /*
      Obraz.
    */

    const imageMatch =
      around.match(
        /<img[^>]+(?:src|data-src)=["']([^"']+)["']/i
      );

    let image =
      imageMatch?.[1] ||
      null;

    if (
      image &&
      image.startsWith("//")
    ) {
      image =
        "https:" + image;
    }

    if (
      image &&
      image.startsWith("/")
    ) {
      image =
        "https://skupszop.pl" +
        image;
    }

    /*
      ISBN w URL pomaga odsiać
      linki nieproduktowe.
    */

    const hasIsbnInUrl =
      /(?:978|979)\d{10}/.test(
        url
      );

    /*
      Dodatkowy kontekst książkowy.
    */

    const context =
      normalize(
        title +
        " " +
        cleanText(around)
      );

    const looksRelevant =
      hasIsbnInUrl ||
      context.includes(
        "warhammer"
      ) ||
      context.includes(
        "horus"
      ) ||
      context.includes(
        "black library"
      ) ||
      context.includes(
        "herezja horusa"
      );

    if (!looksRelevant) {
      continue;
    }

    products.push({
      source:
        "skupszop",

      condition,

      title,

      price,

      rawPrice,

      currency:
        "PLN",

      available:
        price != null,

      stock:
        null,

      image,

      url,
    });
  }

  const unique =
    new Map();

  for (const product of products) {
    if (
      !unique.has(
        product.url
      )
    ) {
      unique.set(
        product.url,
        product
      );
    }
  }

  return [
    ...unique.values(),
  ];
}

async function fetchSkupCatalogPage(
  base,
  page
) {
  /*
    Pierwsza strona bez parametru.
    Kolejne testujemy z ?p=.
  */

  const url =
    page === 1
      ? base
      : `${base}?p=${page}`;

  return await fetchHtml(url);
}

async function getSkupCatalog() {
  const catalogs = [
    "https://skupszop.pl/wydawnictwo/black-library",
    "https://skupszop.pl/wydawnictwo/copernicus-center-press",
  ];

  const all = [];

  /*
    Na początek max 8 stron na wydawnictwo.
    Jeśli okaże się, że katalog jest większy,
    zwiększymy.
  */

  const MAX_PAGES = 8;

  for (const base of catalogs) {
    for (
      let page = 1;
      page <= MAX_PAGES;
      page++
    ) {
      try {
        const html =
          await fetchSkupCatalogPage(
            base,
            page
          );

        const products =
          parseSkupPage(
            html
          );

        all.push(
          ...products
        );

        /*
          Jeśli po pierwszej stronie
          kolejna nie daje żadnych produktów,
          kończymy ten katalog.
        */

        if (
          page > 1 &&
          products.length === 0
        ) {
          break;
        }

        await sleep(120);

      } catch (error) {
        console.error(
          `SkupSzop ${base} page ${page}`,
          error.message
        );

        break;
      }
    }
  }

  const unique =
    new Map();

  for (const product of all) {
    const key =
      product.url ||
      normalize(product.title);

    if (!unique.has(key)) {
      unique.set(
        key,
        product
      );
    }
  }

  return [
    ...unique.values(),
  ];
}

/*
  ============================================
  DOPASOWYWANIE KATALOGÓW
  ============================================
*/

function findCatalogOffers(
  book,
  catalog,
  minimumScore = 65
) {
  const matches = [];

  for (const product of catalog) {
    const score =
      bestBookScore(
        book,
        product.title
      );

    if (
      score >= minimumScore
    ) {
      matches.push({
        ...product,

        matchScore:
          Math.round(score),
      });
    }
  }

  return matches
    .sort((a, b) => {
      if (
        b.matchScore !==
        a.matchScore
      ) {
        return (
          b.matchScore -
          a.matchScore
        );
      }

      if (
        a.price == null &&
        b.price == null
      ) {
        return 0;
      }

      if (
        a.price == null
      ) {
        return 1;
      }

      if (
        b.price == null
      ) {
        return -1;
      }

      return (
        a.price -
        b.price
      );
    })
    .slice(0, 15);
}

/*
  ============================================
  ŁĄCZENIE ŹRÓDEŁ
  ============================================
*/

async function findBook(
  book,
  hegemonCatalog,
  skupCatalog
) {
  /*
    ALLEGRO LOKALNIE
  */

  let allegroOffers = [];
  let allegroError = null;

  try {
    const raw =
      await searchLokalnie(
        book.originalTitle
      );

    for (const offer of raw) {
      const score =
        allegroOfferScore(
          book,
          offer
        );

      if (
        score >= 60
      ) {
        allegroOffers.push({
          ...offer,

          matchScore:
            score,
        });
      }
    }

  } catch (error) {
    allegroError =
      error.message;
  }

  const allegroUnique =
    new Map();

  for (const offer of allegroOffers) {
    if (
      !allegroUnique.has(
        offer.url
      )
    ) {
      allegroUnique.set(
        offer.url,
        offer
      );
    }
  }

  allegroOffers =
    [
      ...allegroUnique.values(),
    ];

  /*
    HEGEMON
  */

  const hegemonOffers =
    findCatalogOffers(
      book,
      hegemonCatalog,
      65
    );

  /*
    SKUPSZOP
  */

  const skupOffers =
    findCatalogOffers(
      book,
      skupCatalog,
      65
    );

  /*
    Rozdzielamy SkupSzop
    na nowe i używane.
  */

  const skupNewOffers =
    skupOffers.filter(
      (offer) =>
        offer.condition ===
        "new"
    );

  const skupUsedOffers =
    skupOffers.filter(
      (offer) =>
        offer.condition !==
        "new"
    );

  const cheapestAllegro =
    cheapest(
      allegroOffers
    );

  const cheapestHegemon =
    cheapest(
      hegemonOffers
    );

  const cheapestSkupNew =
    cheapest(
      skupNewOffers
    );

  const cheapestSkupUsed =
    cheapest(
      skupUsedOffers
    );

  /*
    NOWE
  */

  const newCandidates =
    [
      cheapestHegemon,
      cheapestSkupNew,
    ]
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.price -
          b.price
      );

  const bestNew =
    newCandidates[0] ||
    null;

  /*
    UŻYWANE
  */

  const usedCandidates =
    [
      cheapestAllegro,
      cheapestSkupUsed,
    ]
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.price -
          b.price
      );

  const bestUsed =
    usedCandidates[0] ||
    null;

  return {
    ...book,

    found:
      allegroOffers.length > 0 ||
      hegemonOffers.length > 0 ||
      skupOffers.length > 0,

    sources: {
      allegro_lokalnie: {
        found:
          allegroOffers.length > 0,

        error:
          allegroError,

        offerCount:
          allegroOffers.length,

        lowestPrice:
          cheapestAllegro?.price ??
          null,

        offers:
          allegroOffers.slice(
            0,
            20
          ),
      },

      hegemon: {
        found:
          hegemonOffers.length > 0,

        offerCount:
          hegemonOffers.length,

        lowestPrice:
          cheapestHegemon?.price ??
          null,

        offers:
          hegemonOffers,
      },

      skupszop: {
        found:
          skupOffers.length > 0,

        offerCount:
          skupOffers.length,

        lowestPrice:
          cheapest(
            skupOffers
          )?.price ??
          null,

        newOfferCount:
          skupNewOffers.length,

        usedOfferCount:
          skupUsedOffers.length,

        lowestNewPrice:
          cheapestSkupNew?.price ??
          null,

        lowestUsedPrice:
          cheapestSkupUsed?.price ??
          null,

        offers:
          skupOffers,
      },
    },

    bestUsedPrice:
      bestUsed?.price ??
      null,

    bestUsedSource:
      bestUsed?.source ??
      null,

    bestUsedUrl:
      bestUsed?.url ??
      null,

    bestNewPrice:
      bestNew?.price ??
      null,

    bestNewSource:
      bestNew?.source ??
      null,

    bestNewUrl:
      bestNew?.url ??
      null,
  };
}

/*
  ============================================
  API
  ============================================
*/

export async function GET(request) {
  try {
    const {
      searchParams,
    } =
      new URL(
        request.url
      );

    let offset =
      Number(
        searchParams.get(
          "offset"
        ) || 0
      );

    let limit =
      Number(
        searchParams.get(
          "limit"
        ) || 1
      );

    if (
      !Number.isInteger(offset) ||
      offset < 0
    ) {
      offset = 0;
    }

    if (
      !Number.isInteger(limit) ||
      limit < 1
    ) {
      limit = 1;
    }

    /*
      Max 3 głównie ze względu
      na Allegro Lokalnie.
    */

    limit =
      Math.min(
        limit,
        3
      );

    /*
      Hegemon i SkupSzop pobieramy
      jako katalogi, tylko raz
      na cały request.
    */

    const [
      hegemonCatalog,
      skupCatalog,
    ] =
      await Promise.all([
        getHegemonCatalog(),
        getSkupCatalog(),
      ]);

    const selected =
      BOOKS.slice(
        offset,
        offset + limit
      );

    const books = [];

    for (const book of selected) {
      const result =
        await findBook(
          book,
          hegemonCatalog,
          skupCatalog
        );

      books.push(
        result
      );

      await sleep(800);
    }

    const nextOffset =
      offset +
      books.length;

    return new Response(
      JSON.stringify(
        {
          updatedAt:
            new Date()
              .toISOString(),

          sources: [
            "allegro_lokalnie",
            "hegemon",
            "skupszop",
          ],

          totalBooks:
            BOOKS.length,

          catalogStats: {
            hegemon:
              hegemonCatalog.length,

            skupszop:
              skupCatalog.length,
          },

          offset,

          processed:
            books.length,

          found:
            books.filter(
              (book) =>
                book.found
            ).length,

          nextOffset:
            nextOffset <
            BOOKS.length
              ? nextOffset
              : null,

          finished:
            nextOffset >=
            BOOKS.length,

          books,
        },
        null,
        2
      ),

      {
        headers: {
          "Content-Type":
            "application/json; charset=utf-8",

          "Access-Control-Allow-Origin":
            "*",

          "Cache-Control":
            "public, s-maxage=300, stale-while-revalidate=3600",
        },
      }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({
        error:
          "Multi-source search failed",

        details:
          error.message,
      }),

      {
        status: 500,

        headers: {
          "Content-Type":
            "application/json; charset=utf-8",

          "Access-Control-Allow-Origin":
            "*",
        },
      }
    );
  }
}
