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

function cleanText(value = "") {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
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

  if (a === b) return 100;

  if (b.includes(a)) {
    return 95;
  }

  const words = a
    .split(" ")
    .filter((word) => word.length > 2);

  if (!words.length) {
    return 0;
  }

  const foundWords =
    new Set(b.split(" "));

  let matches = 0;

  for (const word of words) {
    if (foundWords.has(word)) {
      matches++;
    }
  }

  return (
    matches / words.length
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
    throw new Error(
      "RATE_LIMITED"
    );
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  return await response.text();
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

    const price =
      priceMatch?.[1]
        ? parsePrice(
            priceMatch[1]
          )
        : null;

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

      currency:
        "PLN",

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

  for (const result of results) {
    if (
      !unique.has(
        result.url
      )
    ) {
      unique.set(
        result.url,
        result
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

  /*
    Zamiast wycinać całe <article>,
    szukamy wszystkich tytułów produktów.

    To powinno zebrać pełne 36 pozycji
    na stronie.
  */

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
      cleanText(match[2]);

    if (!title) continue;

    /*
      Bierzemy fragment strony wokół
      konkretnego tytułu produktu.
    */

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
  const match =
    html.match(
      /Jest\s+(\d+)\s+produkt/i
    );

  if (!match) {
    return 11;
  }

  const total =
    Number(match[1]);

  if (!total) {
    return 11;
  }

  return Math.ceil(
    total / 36
  );
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

  /*
    Pierwsza strona już pobrana,
    więc zaczynamy od 2.
  */

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

      const products =
        parseHegemonPage(
          html
        );

      all.push(
        ...products
      );

      await sleep(120);

    } catch (error) {
      console.error(
        `Hegemon page ${page}:`,
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
  MEGAKSIAZKI
  ============================================
*/

function parseMegaPage(html) {
  const products = [];

  /*
    Na MegaKsiazki tytuły produktów
    występują jako <h2><a ...>.
  */

  const regex =
    /<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/gi;

  let match;

  while (
    (match =
      regex.exec(html)) !== null
  ) {
    let url =
      match[1];

    const title =
      cleanText(
        match[2]
      );

    if (
      !title ||
      title.length < 2
    ) {
      continue;
    }

    if (
      url.startsWith("/")
    ) {
      url =
        "https://www.megaksiazki.pl" +
        url;
    }

    const around =
      html.slice(
        match.index,

        Math.min(
          html.length,
          match.index + 3000
        )
      );

    const priceMatch =
      around.match(
        /(\d[\d\s]*[,.]\d{2})\s*zł/i
      );

    const price =
      priceMatch
        ? parsePrice(
            priceMatch[1]
          )
        : null;

    const available =
      /W magazynie|Dostępne/i
        .test(around);

    const unavailable =
      /niedostępny|niedostępne/i
        .test(around);

    const imageMatch =
      around.match(
        /<img[^>]+(?:src|data-src)=["']([^"']+)["']/i
      );

    products.push({
      source:
        "megaksiazki",

      condition:
        "new",

      title,

      price,

      rawPrice:
        priceMatch?.[0] ||
        null,

      currency:
        "PLN",

      available:
        unavailable
          ? false
          : available
            ? true
            : null,

      stock:
        null,

      image:
        imageMatch?.[1] ||
        null,

      url,
    });
  }

  return products;
}

async function getMegaCatalog() {
  const base =
    "https://www.megaksiazki.pl/3024-warhammer-40-000";

  const all = [];

  /*
    MegaKsiazki ma bardzo dużo stron
    katalogu.

    Na tym etapie bierzemy pierwsze 8.
    To około 160 produktów.

    Dzięki temu request nie powinien
    trwać absurdalnie długo.
  */

  const MAX_PAGES = 8;

  for (
    let page = 1;
    page <= MAX_PAGES;
    page++
  ) {
    try {
      const url =
        page === 1
          ? base
          : `${base}?p=${page}`;

      const html =
        await fetchHtml(url);

      const products =
        parseMegaPage(
          html
        );

      if (
        products.length === 0
      ) {
        break;
      }

      all.push(
        ...products
      );

      await sleep(120);

    } catch (error) {
      console.error(
        `MegaKsiazki page ${page}:`,
        error.message
      );

      break;
    }
  }

  const unique =
    new Map();

  for (const item of all) {
    const key =
      item.url ||
      normalize(
        item.title
      );

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
    .slice(0, 10);
}

function cheapest(offers) {
  return offers
    .filter(
      (item) =>
        item.price != null
    )
    .sort(
      (a, b) =>
        a.price -
        b.price
    )[0] || null;
}

/*
  ============================================
  ŁĄCZENIE ŹRÓDEŁ
  ============================================
*/

async function findBook(
  book,
  hegemonCatalog,
  megaCatalog
) {
  /*
    Allegro Lokalnie
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

  for (
    const item
    of allegroOffers
  ) {
    if (
      !allegroUnique.has(
        item.url
      )
    ) {
      allegroUnique.set(
        item.url,
        item
      );
    }
  }

  allegroOffers =
    [
      ...allegroUnique.values(),
    ];

  /*
    Hegemon
  */

  const hegemonOffers =
    findCatalogOffers(
      book,
      hegemonCatalog,
      65
    );

  /*
    MegaKsiazki
  */

  const megaOffers =
    findCatalogOffers(
      book,
      megaCatalog,
      65
    );

  const cheapestAllegro =
    cheapest(
      allegroOffers
    );

  const cheapestHegemon =
    cheapest(
      hegemonOffers
    );

  const cheapestMega =
    cheapest(
      megaOffers
    );

  /*
    Najtańsza NOWA oferta
    spośród sklepów.
  */

  const newCandidates =
    [
      cheapestHegemon,
      cheapestMega,
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

  return {
    ...book,

    found:
      allegroOffers.length > 0 ||
      hegemonOffers.length > 0 ||
      megaOffers.length > 0,

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

      megaksiazki: {
        found:
          megaOffers.length > 0,

        offerCount:
          megaOffers.length,

        lowestPrice:
          cheapestMega?.price ??
          null,

        offers:
          megaOffers,
      },
    },

    bestUsedPrice:
      cheapestAllegro?.price ??
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

    limit =
      Math.min(
        limit,
        3
      );

    /*
      Oba katalogi sklepowe pobieramy
      tylko raz na cały request.
    */

    const [
      hegemonCatalog,
      megaCatalog,
    ] =
      await Promise.all([
        getHegemonCatalog(),
        getMegaCatalog(),
      ]);

    const selected =
      BOOKS.slice(
        offset,
        offset + limit
      );

    const books = [];

    for (
      const book
      of selected
    ) {
      const result =
        await findBook(
          book,
          hegemonCatalog,
          megaCatalog
        );

      books.push(
        result
      );

      /*
        Tylko Allegro Lokalnie
        generuje wyszukiwanie per książka.
      */

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
            "megaksiazki",
          ],

          totalBooks:
            BOOKS.length,

          catalogStats: {
            hegemon:
              hegemonCatalog.length,

            megaksiazki:
              megaCatalog.length,
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
