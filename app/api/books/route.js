import { BOOKS } from "../../../lib/books.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function cleanText(value = "") {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
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

  const cleaned = match[1]
    .replace(/\s/g, "")
    .replace(",", ".");

  const number = Number(cleaned);

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

/*
  =========================
  ALLEGRO LOKALNIE
  =========================
*/

function allegroOfferScore(book, result) {
  const text = normalize(result.title);

  let score = Math.max(
    scoreMatch(
      book.originalTitle,
      result.title
    ),

    book.polishTitle
      ? scoreMatch(
          book.polishTitle,
          result.title
        )
      : 0
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
      text.includes(normalize(word))
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
    "karta pokemon",
    "karty pokemon",
    "lego",
    "koszulka",
    "plakat",
    "kubek",
    "brelok",
    "naklejka",
    "naklejki",
    "puzzle",
    "figurka",
    "figurki",
    "miniatura",
  ];

  for (const word of badWords) {
    if (
      text.includes(normalize(word))
    ) {
      score -= 60;
    }
  }

  const softBadWords = [
    "gra planszowa",
    "podrecznik",
    "codex",
    "kodeks",
    "dice",
    "kostki",
    "model",
  ];

  for (const word of softBadWords) {
    if (
      text.includes(normalize(word))
    ) {
      score -= 20;
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

    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/140.0.0.0 Safari/537.36",

      "Accept-Language":
        "pl-PL,pl;q=0.9,en;q=0.8",

      Accept:
        "text/html,application/xhtml+xml," +
        "application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (response.status === 429) {
    const retryAfter =
      response.headers.get("retry-after");

    throw new Error(
      retryAfter
        ? `RATE_LIMITED - retry after ${retryAfter}s`
        : "RATE_LIMITED"
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
    (match = linkRegex.exec(html)) !== null
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

    const rawPrice =
      priceMatch?.[0] || null;

    const price =
      priceMatch?.[1]
        ? parsePrice(priceMatch[1])
        : parsePrice(rawPrice);

    const title =
      cleanOfferTitle(anchorHtml);

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

      rawPrice,

      currency:
        "PLN",

      image:
        imageMatch?.[1] || null,

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

  const unique = new Map();

  for (const result of results) {
    if (!unique.has(result.url)) {
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
  =========================
  HEGEMON
  =========================
*/

/*
  Hegemon ma 369 produktów i paginację.
  Nie odpytujemy osobno każdego tytułu.

  Pobieramy strony kategorii,
  a następnie dopasowujemy książkę
  do pobranego katalogu.
*/

async function fetchHegemonPage(page = 1) {
  const baseUrl =
    "https://hegemonshop.com/pl/314-black-library";

  const url =
    page === 1
      ? baseUrl
      : `${baseUrl}?page=${page}`;

  const response = await fetch(url, {
    next: {
      revalidate: 3600,
    },

    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/140.0.0.0 Safari/537.36",

      "Accept-Language":
        "pl-PL,pl;q=0.9,en;q=0.8",

      Accept:
        "text/html,application/xhtml+xml," +
        "application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Hegemon HTTP ${response.status}`
    );
  }

  return await response.text();
}

function parseHegemonPage(html) {
  const products = [];

  /*
    Hegemon/PrestaShop trzyma produkty
    w kontenerach article.product-miniature.
  */

  const productBlocks =
    html.match(
      /<article[^>]+class=["'][^"']*product-miniature[^"']*["'][\s\S]*?<\/article>/gi
    ) || [];

  for (const block of productBlocks) {
    let title = null;
    let url = null;

    const titleLink =
      block.match(
        /<h2[^>]*class=["'][^"']*product-title[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i
      ) ||
      block.match(
        /<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*product-thumbnail[^"']*["'][^>]*>[\s\S]*?<\/a>[\s\S]*?<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i
      );

    if (titleLink) {
      url =
        titleLink[1] || null;

      title =
        cleanText(
          titleLink[2] || ""
        );
    }

    /*
      Awaryjny parser tytułu.
    */

    if (!title) {
      const fallbackTitle =
        block.match(
          /<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i
        );

      if (fallbackTitle) {
        url =
          fallbackTitle[1];

        title =
          cleanText(
            fallbackTitle[2]
          );
      }
    }

    if (!title) {
      continue;
    }

    const priceMatch =
      block.match(
        /(?:class=["'][^"']*(?:price|product-price)[^"']*["'][^>]*>[\s\S]*?)?(\d[\d\s]*[,.]\d{2})\s*(?:&nbsp;|\u00a0|\s)*zł/i
      );

    const price =
      priceMatch
        ? parsePrice(priceMatch[1])
        : null;

    const rawPrice =
      priceMatch?.[0]
        ? cleanText(priceMatch[0])
        : null;

    const stockMatch =
      block.match(
        /Na stanie\s*:?\s*(\d+)\s*szt/i
      );

    const stock =
      stockMatch
        ? Number(stockMatch[1])
        : null;

    const imageMatch =
      block.match(
        /<img[^>]+(?:src|data-src)=["']([^"']+)["']/i
      );

    products.push({
      source:
        "hegemon",

      condition:
        "new",

      title,

      price,

      rawPrice,

      currency:
        "PLN",

      stock,

      available:
        stock == null
          ? null
          : stock > 0,

      image:
        imageMatch?.[1] || null,

      url,
    });
  }

  return products;
}

async function getHegemonCatalog() {
  const allProducts = [];

  /*
    Hegemon pokazuje 36 produktów na stronie
    i ma obecnie ok. 11 stron.

    Na potrzeby pierwszego testu pobieramy
    maksymalnie 11 stron.
  */

  for (
    let page = 1;
    page <= 11;
    page++
  ) {
    try {
      const html =
        await fetchHegemonPage(
          page
        );

      const products =
        parseHegemonPage(
          html
        );

      allProducts.push(
        ...products
      );

      /*
        Jeśli strona nic nie zwróciła,
        dalszej paginacji nie ma sensu.
      */

      if (
        products.length === 0
      ) {
        break;
      }

      await sleep(150);

    } catch (error) {
      /*
        Nie zabijamy całego endpointu,
        jeśli np. strona 10 się nie uda.
      */

      console.error(
        `Hegemon page ${page}:`,
        error.message
      );

      break;
    }
  }

  const unique =
    new Map();

  for (
    const product
    of allProducts
  ) {
    const key =
      product.url ||
      normalize(
        product.title
      );

    if (
      !unique.has(key)
    ) {
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

function findHegemonOffers(
  book,
  catalog
) {
  const matches = [];

  for (
    const product
    of catalog
  ) {
    const score =
      Math.max(
        scoreMatch(
          book.originalTitle,
          product.title
        ),

        book.polishTitle
          ? scoreMatch(
              book.polishTitle,
              product.title
            )
          : 0
      );

    /*
      W specjalistycznej kategorii
      Black Library możemy być trochę
      bardziej liberalni niż na Allegro.
    */

    if (score >= 65) {
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

/*
  =========================
  ŁĄCZENIE ŹRÓDEŁ
  =========================
*/

async function findBook(
  book,
  hegemonCatalog
) {
  const query =
    book.originalTitle;

  let allegroOffers = [];
  let allegroError = null;

  try {
    const results =
      await searchLokalnie(
        query
      );

    for (
      const result
      of results
    ) {
      const score =
        allegroOfferScore(
          book,
          result
        );

      if (score >= 60) {
        allegroOffers.push({
          ...result,

          matchScore:
            score,
        });
      }
    }
  } catch (error) {
    allegroError =
      error.message;
  }

  /*
    Usuwamy duplikaty Allegro.
  */

  const allegroUnique =
    new Map();

  for (
    const offer
    of allegroOffers
  ) {
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
    ].sort((a, b) => {
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
    });

  const hegemonOffers =
    findHegemonOffers(
      book,
      hegemonCatalog
    );

  const cheapestAllegro =
    allegroOffers.find(
      (offer) =>
        offer.price != null
    );

  const cheapestHegemon =
    [...hegemonOffers]
      .filter(
        (offer) =>
          offer.price != null
      )
      .sort(
        (a, b) =>
          a.price -
          b.price
      )[0];

  return {
    ...book,

    found:
      allegroOffers.length > 0 ||
      hegemonOffers.length > 0,

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
    },

    bestUsedPrice:
      cheapestAllegro?.price ??
      null,

    bestNewPrice:
      cheapestHegemon?.price ??
      null,
  };
}

/*
  =========================
  API
  =========================
*/

export async function GET(
  request
) {
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
      !Number.isInteger(
        offset
      ) ||
      offset < 0
    ) {
      offset = 0;
    }

    if (
      !Number.isInteger(
        limit
      ) ||
      limit < 1
    ) {
      limit = 1;
    }

    /*
      Na razie testujemy małe partie.
    */

    limit =
      Math.min(
        limit,
        3
      );

    /*
      Katalog Hegemon pobieramy raz
      dla całego requestu,
      a nie osobno dla każdej książki.
    */

    const hegemonCatalog =
      await getHegemonCatalog();

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
          hegemonCatalog
        );

      books.push(
        result
      );

      /*
        Allegro Lokalnie jest źródłem,
        przy którym mieliśmy 429.
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
          ],

          totalBooks:
            BOOKS.length,

          hegemonCatalogSize:
            hegemonCatalog.length,

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
        status:
          500,

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
