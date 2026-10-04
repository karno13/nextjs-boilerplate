import { BOOKS } from "../../../lib/books.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_VERSION = "catalog-search-fallback-v4";

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
  ============================================================
  HELPERY
  ============================================================
*/

function cleanText(value = "") {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&#039;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
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
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePrice(value) {
  if (!value) {
    return null;
  }

  const match = String(value).match(
    /(\d[\d\s]*(?:[,.]\d{1,2})?)/
  );

  if (!match) {
    return null;
  }

  const number = Number(
    match[1]
      .replace(/\s/g, "")
      .replace(",", ".")
  );

  return Number.isFinite(number)
    ? number
    : null;
}

function absoluteUrl(base, value) {
  if (!value) {
    return null;
  }

  if (
    value.startsWith("https://") ||
    value.startsWith("http://")
  ) {
    return value;
  }

  if (value.startsWith("//")) {
    return `https:${value}`;
  }

  if (value.startsWith("/")) {
    return `${base}${value}`;
  }

  return `${base}/${value}`;
}

/*
  ============================================================
  FETCH
  ============================================================
*/

async function fetchHtml(
  url,
  revalidate = 3600
) {
  const response = await fetch(url, {
    headers: HEADERS,

    next: {
      revalidate,
    },

    redirect: "follow",
  });

  if (response.status === 429) {
    throw new Error(
      `RATE_LIMITED ${url}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${url}`
    );
  }

  return await response.text();
}

/*
  ============================================================
  MATCHER
  ============================================================
*/

function scoreMatch(wanted, found) {
  const a = normalize(wanted);
  const b = normalize(found);

  if (!a || !b) {
    return 0;
  }

  if (a === b) {
    return 100;
  }

  const wantedWords = a
    .split(" ")
    .filter(
      (word) =>
        word.length > 2
    );

  const foundWords = b
    .split(" ")
    .filter(Boolean);

  if (!wantedWords.length) {
    return 0;
  }

  /*
    Tytuł jednowyrazowy.
    Legion != Legions.
  */

  if (
    wantedWords.length === 1
  ) {
    const word =
      wantedWords[0];

    if (
      !foundWords.includes(word)
    ) {
      return 0;
    }

    return 55;
  }

  if (b.includes(a)) {
    return 95;
  }

  const foundSet =
    new Set(foundWords);

  let matches = 0;

  for (const word of wantedWords) {
    if (foundSet.has(word)) {
      matches++;
    }
  }

  return (
    matches /
    wantedWords.length
  ) * 100;
}

function bestBookScore(book, title) {
  const scores = [];

  if (book.originalTitle) {
    scores.push(
      scoreMatch(
        book.originalTitle,
        title
      )
    );
  }

  if (book.polishTitle) {
    scores.push(
      scoreMatch(
        book.polishTitle,
        title
      )
    );
  }

  if (
    Array.isArray(
      book.searchTerms
    )
  ) {
    for (
      const term
      of book.searchTerms
    ) {
      if (!term) {
        continue;
      }

      scores.push(
        scoreMatch(
          term,
          title
        )
      );
    }
  }

  return scores.length
    ? Math.max(...scores)
    : 0;
}

/*
  ============================================================
  MATCHER ZAUFANYCH KATALOGÓW
  ============================================================
*/

function trustedCatalogBookScore(
  book,
  title
) {
  const normalTitle =
    normalize(title);

  const candidates = [
    book.originalTitle,
    book.polishTitle,

    ...(Array.isArray(
      book.searchTerms
    )
      ? book.searchTerms
      : []),
  ]
    .filter(Boolean)
    .map(normalize);

  let best = 0;

  for (
    const candidate
    of candidates
  ) {
    const wantedWords =
      candidate
        .split(" ")
        .filter(
          (word) =>
            word.length > 2
        );

    if (!wantedWords.length) {
      continue;
    }

    if (
      wantedWords.length > 1
    ) {
      best = Math.max(
        best,

        scoreMatch(
          candidate,
          normalTitle
        )
      );

      continue;
    }

    const wanted =
      wantedWords[0];

    const foundWords =
      normalTitle
        .split(" ")
        .filter(Boolean);

    if (
      !foundWords.includes(
        wanted
      )
    ) {
      continue;
    }

    const harmlessWords =
      new Set([
        "horus",
        "heresy",
        "the",
        "warhammer",
        "40000",
        "40k",
        "pb",
        "hb",
        "eng",
        "paperback",
        "hardback",
        "softback",
        "edition",
        "novel",
        "book",
      ]);

    const otherWords =
      foundWords.filter(
        (word) =>
          word !== wanted &&
          !harmlessWords.has(word)
      );

    if (
      otherWords.length === 0
    ) {
      best = Math.max(
        best,
        95
      );

    } else {
      best = Math.max(
        best,
        55
      );
    }
  }

  return best;
}

/*
  ============================================================
  CENY
  ============================================================
*/

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

function cheapestAvailable(
  offers
) {
  return (
    offers
      .filter(
        (offer) =>
          offer.price != null &&
          offer.available === true
      )
      .sort(
        (a, b) =>
          a.price - b.price
      )[0] || null
  );
}

/*
  ============================================================
  ALLEGRO LOKALNIE
  ============================================================
*/

function allegroOfferScore(
  book,
  result
) {
  const text =
    normalize(
      result.title
    );

  let score =
    bestBookScore(
      book,
      result.title
    );

  const wanted =
    normalize(
      book.originalTitle
    );

  const wantedWords =
    wanted
      .split(" ")
      .filter(
        (word) =>
          word.length > 2
      );

  const foundWords =
    text
      .split(" ")
      .filter(Boolean);

  const positiveContext = [
    "warhammer",
    "black library",
    "horus heresy",
    "herezja horusa",
    "40k",
    "40000",
    "games workshop",
    "ksiazka",
    "powiesc",
    "paperback",
    "hardback",
    "novel",
  ];

  let hasBookContext =
    false;

  for (
    const context
    of positiveContext
  ) {
    if (
      text.includes(
        normalize(context)
      )
    ) {
      hasBookContext =
        true;

      score += 10;
    }
  }

  if (
    wantedWords.length === 1
  ) {
    const word =
      wantedWords[0];

    const exactTokenIndex =
      foundWords.indexOf(
        word
      );

    if (
      exactTokenIndex === -1
    ) {
      return 0;
    }

    if (!hasBookContext) {
      score -= 60;
    }

    if (
      exactTokenIndex === 0
    ) {
      score += 30;

    } else if (
      exactTokenIndex <= 2
    ) {
      score += 15;

    } else {
      score -= 40;
    }

    if (
      exactTokenIndex > 0
    ) {
      const previousWord =
        foundWords[
          exactTokenIndex - 1
        ];

      const safePreviousWords =
        new Set([
          "warhammer",
          "heresy",
          "horusa",
          "horus",
          "ksiazka",
          "powiesc",
          "tom",
        ]);

      if (
        previousWord &&
        !safePreviousWords.has(
          previousWord
        )
      ) {
        score -= 35;
      }
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
    "miniatury",
    "battle group",
    "battleforce",
    "destructors",
    "myrmidon",
    "army set",
    "zestaw figurek",
    "model do gry",
    "modele do gry",
    "lenovo",
    "laptop",
    "komputer",
    "monitor",
    "konsola",
    "zasilacz",
    "ssd",
    "rtx",
    "geforce",
    "ryzen",
    "world of warcraft",
    "wow gold",
    "bmx",
  ];

  for (
    const bad
    of badWords
  ) {
    if (
      text.includes(
        normalize(bad)
      )
    ) {
      score -= 80;
    }
  }

  return Math.round(score);
}

async function searchLokalnie(
  query
) {
  const url =
    "https://allegrolokalnie.pl/oferty/q/" +
    encodeURIComponent(query);

  const html =
    await fetchHtml(
      url,
      3600
    );

  const results = [];

  const linkRegex =
    /href=["'](\/oferta\/[^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while (
    (match =
      linkRegex.exec(html)) !==
    null
  ) {
    const relativeUrl =
      match[1];

    const anchorHtml =
      match[2];

    const fullText =
      cleanText(
        anchorHtml
      );

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

      currency:
        "PLN",

      available:
        true,

      image:
        imageMatch?.[1] ||
        null,

      url:
        "https://allegrolokalnie.pl" +
        relativeUrl,
    });

    if (
      results.length >= 60
    ) {
      break;
    }
  }

  const unique =
    new Map();

  for (
    const item
    of results
  ) {
    if (
      !unique.has(
        item.url
      )
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
  ============================================================
  HEGEMON - PARSER PRODUKTÓW
  ============================================================
*/

function parseHegemonProducts(
  html,
  origin = "catalog"
) {
  const products = [];

  const articleRegex =
    /<article\b[^>]*class=["'][^"']*product-miniature[^"']*["'][^>]*>[\s\S]*?<\/article>/gi;

  let match;

  while (
    (match =
      articleRegex.exec(html)) !==
    null
  ) {
    const block =
      match[0];

    const idMatch =
      block.match(
        /data-id-product=["'](\d+)["']/i
      );

    const titleMatch =
      block.match(
        /<h2[^>]*class=["'][^"']*product-title[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i
      );

    if (!titleMatch) {
      continue;
    }

    const url =
      titleMatch[1];

    const title =
      cleanText(
        titleMatch[2]
      );

    if (
      !url ||
      !title
    ) {
      continue;
    }

    const priceMatch =
      block.match(
        /<span[^>]*class=["'][^"']*\bprice\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
      ) ||
      block.match(
        /(\d[\d\s]*[,.]\d{2})\s*(?:&nbsp;|&#160;|\s|\u00a0)*zł/i
      );

    const stockMatch =
      cleanText(block).match(
        /Na stanie\s*:?\s*(\d+)\s*szt/i
      );

    const imageMatch =
      block.match(
        /<img[^>]+(?:data-src|src)=["']([^"']+)["']/i
      );

    products.push({
      source:
        "hegemon",

      discoverySource:
        origin,

      condition:
        "new",

      productId:
        idMatch?.[1] ||
        null,

      title,

      price:
        priceMatch
          ? parsePrice(
              cleanText(
                priceMatch[1] ||
                priceMatch[0]
              )
            )
          : null,

      rawPrice:
        priceMatch
          ? cleanText(
              priceMatch[0]
            )
          : null,

      currency:
        "PLN",

      stock:
        stockMatch
          ? Number(
              stockMatch[1]
            )
          : null,

      available:
        null,

      availabilityChecked:
        false,

      image:
        imageMatch?.[1] ||
        null,

      url,
    });
  }

  /*
    Fallback dla przypadków,
    gdzie article nie dało produktu.
  */

  const looseRegex =
    /<h2[^>]*class=["'][^"']*product-title[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  while (
    (match =
      looseRegex.exec(html)) !==
    null
  ) {
    const url =
      match[1];

    const title =
      cleanText(
        match[2]
      );

    if (
      !url ||
      !title
    ) {
      continue;
    }

    products.push({
      source:
        "hegemon",

      discoverySource:
        origin,

      condition:
        "new",

      productId:
        null,

      title,

      price:
        null,

      rawPrice:
        null,

      currency:
        "PLN",

      stock:
        null,

      available:
        null,

      availabilityChecked:
        false,

      image:
        null,

      url,
    });
  }

  const unique =
    new Map();

  for (
    const product
    of products
  ) {
    const key =
      product.productId
        ? `id:${product.productId}`
        : `url:${product.url}`;

    if (!unique.has(key)) {
      unique.set(
        key,
        product
      );

      continue;
    }

    const previous =
      unique.get(key);

    unique.set(
      key,
      {
        ...product,
        ...previous,

        price:
          previous.price ??
          product.price,

        rawPrice:
          previous.rawPrice ??
          product.rawPrice,

        image:
          previous.image ??
          product.image,

        productId:
          previous.productId ??
          product.productId,
      }
    );
  }

  return [
    ...unique.values(),
  ];
}

/*
  ============================================================
  HEGEMON - INFORMACJA O KATALOGU
  ============================================================
*/

function getHegemonCatalogInfo(
  html
) {
  const text =
    cleanText(html);

  const match =
    text.match(
      /Pokazano\s+(\d+)\s*-\s*(\d+)\s+z\s+(\d+)\s+pozycji/i
    );

  if (!match) {
    return {
      declaredTotal:
        null,

      perPage:
        36,

      pageCount:
        11,
    };
  }

  const from =
    Number(
      match[1]
    );

  const to =
    Number(
      match[2]
    );

  const declaredTotal =
    Number(
      match[3]
    );

  const perPage =
    to - from + 1;

  return {
    declaredTotal,

    perPage,

    pageCount:
      Math.ceil(
        declaredTotal /
        perPage
      ),
  };
}

/*
  ============================================================
  HEGEMON - KATALOG
  ============================================================
*/

async function getHegemonCatalog() {
  const base =
    "https://hegemonshop.com/pl/314-black-library";

  const firstUrl =
    `${base}?order=product.name.asc&page=1`;

  const firstHtml =
    await fetchHtml(
      firstUrl,
      3600
    );

  const info =
    getHegemonCatalogInfo(
      firstHtml
    );

  const unique =
    new Map();

  let pagesFetched = 0;

  const pageCount =
    Math.min(
      Math.max(
        info.pageCount || 11,
        1
      ),
      30
    );

  for (
    let page = 1;
    page <= pageCount;
    page++
  ) {
    try {
      const html =
        page === 1
          ? firstHtml
          : await fetchHtml(
              `${base}?order=product.name.asc&page=${page}`,
              3600
            );

      const products =
        parseHegemonProducts(
          html,
          "catalog"
        );

      for (
        const product
        of products
      ) {
        const key =
          product.productId
            ? `id:${product.productId}`
            : `url:${product.url}`;

        if (
          !unique.has(key)
        ) {
          unique.set(
            key,
            product
          );
        }
      }

      pagesFetched++;

      await sleep(80);

    } catch (error) {
      console.error(
        `Hegemon catalog page ${page}:`,
        error.message
      );
    }
  }

  return {
    items: [
      ...unique.values(),
    ],

    declaredTotal:
      info.declaredTotal,

    pagesFetched,

    pageCount,
  };
}

/*
  ============================================================
  HEGEMON - FALLBACK SEARCH
  ============================================================

  Uruchamiamy tylko wtedy, kiedy książki
  nie znaleziono w wyrenderowanym katalogu.

  Próbujemy kilka wariantów wyszukiwarki.
  Jeśli dany wariant nie zwraca kart produktów,
  po prostu przechodzimy do następnego.
  ============================================================
*/

async function searchHegemon(
  query
) {
  const encoded =
    encodeURIComponent(
      query
    );

  const urls = [
    `https://hegemonshop.com/pl/szukaj?controller=search&s=${encoded}`,
    `https://hegemonshop.com/pl/szukaj?search_query=${encoded}`,
    `https://hegemonshop.com/pl/szukaj?s=${encoded}`,
  ];

  let lastError = null;

  for (
    const url
    of urls
  ) {
    try {
      const html =
        await fetchHtml(
          url,
          1800
        );

      const products =
        parseHegemonProducts(
          html,
          "search"
        );

      if (
        products.length > 0
      ) {
        return {
          url,
          products,
          error:
            null,
        };
      }

    } catch (error) {
      lastError =
        error.message;
    }
  }

  return {
    url:
      null,

    products:
      [],

    error:
      lastError,
  };
}

/*
  ============================================================
  HEGEMON - STRONA PRODUKTU
  ============================================================
*/

function getHegemonMainProductHtml(
  html
) {
  const titleIndex =
    html.search(
      /<h1[^>]*class=["'][^"']*productTitle[^"']*["']/i
    );

  if (
    titleIndex < 0
  ) {
    return html;
  }

  /*
    Bierzemy obszar głównego produktu,
    ale nie sekcje rekomendacji poniżej.
  */

  const possibleEnds = [
    html.indexOf(
      '<div class="tabs"',
      titleIndex
    ),

    html.indexOf(
      'class="product-accessories"',
      titleIndex
    ),

    html.indexOf(
      'class="featured-products"',
      titleIndex
    ),

    html.indexOf(
      'itemprop="isRelatedTo"',
      titleIndex
    ),
  ]
    .filter(
      (value) =>
        value > titleIndex
    );

  const end =
    possibleEnds.length > 0
      ? Math.min(
          ...possibleEnds
        )
      : Math.min(
          html.length,
          titleIndex + 60000
        );

  return html.slice(
    titleIndex,
    end
  );
}

function parseHegemonProductAvailability(
  html
) {
  const scope =
    getHegemonMainProductHtml(
      html
    );

  const text =
    normalize(
      cleanText(scope)
    );

  const stockMatch =
    scope.match(
      /data-stock=["'](\d+)["']/i
    ) ||
    cleanText(scope).match(
      /Na stanie\s*:?\s*(\d+)\s*szt/i
    );

  const stock =
    stockMatch
      ? Number(
          stockMatch[1]
        )
      : null;

  /*
    Schema.org jest najlepszym sygnałem.
  */

  if (
    /schema\.org\/InStock/i.test(
      scope
    )
  ) {
    return {
      available:
        true,

      stock,

      reason:
        "schema_in_stock",
    };
  }

  if (
    /schema\.org\/OutOfStock/i.test(
      scope
    )
  ) {
    return {
      available:
        false,

      stock:
        stock ?? 0,

      reason:
        "schema_out_of_stock",
    };
  }

  if (
    text.includes(
      "obecnie niedostepny"
    ) ||
    /product-unavailable/i.test(
      scope
    )
  ) {
    return {
      available:
        false,

      stock:
        stock ?? 0,

      reason:
        "product_unavailable",
    };
  }

  if (
    Number.isFinite(stock)
  ) {
    return {
      available:
        stock > 0,

      stock,

      reason:
        "stock_count",
    };
  }

  /*
    Przyciskiem posiłkujemy się
    dopiero na końcu.
  */

  const button =
    scope.match(
      /<button[^>]*class=["'][^"']*add-to-cart[^"']*["'][^>]*>/i
    );

  if (button) {
    if (
      /\bdisabled\b/i.test(
        button[0]
      )
    ) {
      return {
        available:
          false,

        stock:
          null,

        reason:
          "cart_disabled",
      };
    }

    return {
      available:
        true,

      stock:
        null,

      reason:
        "cart_enabled",
    };
  }

  return {
    available:
      null,

    stock,

    reason:
      "unknown",
  };
}

async function checkHegemonOfferAvailability(
  offer
) {
  try {
    const html =
      await fetchHtml(
        offer.url,
        300
      );

    const status =
      parseHegemonProductAvailability(
        html
      );

    /*
      Jeżeli wynik wyszukiwarki nie miał ceny,
      próbujemy ją dostać ze strony produktu.
    */

    const priceMatch =
      html.match(
        /<span[^>]*itemprop=["']price["'][^>]*content=["']([^"']+)["']/i
      ) ||
      html.match(
        /itemprop=["']price["'][^>]*content=["']([^"']+)["']/i
      );

    const pagePrice =
      priceMatch
        ? parsePrice(
            priceMatch[1]
          )
        : null;

    const imageMatch =
      html.match(
        /<img[^>]*class=["'][^"']*js-qv-product-cover[^"']*["'][^>]*src=["']([^"']+)["']/i
      );

    return {
      ...offer,

      price:
        offer.price ??
        pagePrice,

      image:
        offer.image ??
        imageMatch?.[1] ??
        null,

      available:
        status.available,

      stock:
        status.stock,

      availabilityChecked:
        true,

      availabilitySource:
        "product_page",

      availabilityReason:
        status.reason,
    };

  } catch (error) {
    return {
      ...offer,

      available:
        null,

      availabilityChecked:
        false,

      availabilitySource:
        "product_page",

      availabilityReason:
        "fetch_error",

      availabilityError:
        error.message,
    };
  }
}

/*
  ============================================================
  PAN MYSZA - KATALOG
  ============================================================
*/

function makePanAbsoluteUrl(
  value
) {
  return absoluteUrl(
    "https://panmysza.pl",
    value
  );
}

function parsePanMyszaPage(
  html
) {
  const products = [];

  const starts = [];

  const startRegex =
    /<div\b[^>]*data-product-id=["']([^"']+)["'][^>]*>/gi;

  let match;

  while (
    (match =
      startRegex.exec(html)) !==
    null
  ) {
    starts.push({
      index:
        match.index,

      productId:
        match[1],
    });
  }

  for (
    let i = 0;
    i < starts.length;
    i++
  ) {
    const start =
      starts[i].index;

    const end =
      i + 1 <
      starts.length
        ? starts[
            i + 1
          ].index
        : Math.min(
            html.length,
            start + 15000
          );

    const block =
      html.slice(
        start,
        end
      );

    const link1 =
      block.match(
        /<a[^>]+href=["']([^"']*\/pl\/p\/[^"']+)["'][^>]*title=["']([^"']+)["'][^>]*>/i
      );

    const link2 =
      block.match(
        /<a[^>]+title=["']([^"']+)["'][^>]*href=["']([^"']*\/pl\/p\/[^"']+)["'][^>]*>/i
      );

    let url = null;
    let title = null;

    if (link1) {
      url =
        link1[1];

      title =
        link1[2];

    } else if (
      link2
    ) {
      title =
        link2[1];

      url =
        link2[2];
    }

    if (!url) {
      const href =
        block.match(
          /href=["']([^"']*\/pl\/p\/[^"']+)["']/i
        );

      url =
        href?.[1] ||
        null;
    }

    if (!title) {
      const name =
        block.match(
          /class=["'][^"']*productname[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i
        );

      if (name) {
        title =
          cleanText(
            name[1]
          );
      }
    }

    if (!title) {
      const alt =
        block.match(
          /<img[^>]+alt=["']([^"']+)["']/i
        );

      title =
        alt
          ? cleanText(
              alt[1]
            )
          : null;
    }

    title =
      cleanText(
        title || ""
      );

    if (
      !url ||
      !title
    ) {
      continue;
    }

    const priceMatch =
      block.match(
        /<em[^>]*>\s*(\d[\d\s]*[,.]\d{2})[\s\S]*?<\/em>/i
      );

    const imageMatch =
      block.match(
        /<img[^>]+data-src=["']([^"']+)["']/i
      ) ||
      block.match(
        /<img[^>]+src=["']([^"']+)["']/i
      );

    let image =
      imageMatch?.[1] ||
      null;

    if (
      image &&
      image.startsWith(
        "data:image"
      )
    ) {
      image = null;
    }

    const opening =
      block.slice(
        0,
        1200
      );

    const categoryMatch =
      opening.match(
        /data-category=["']([^"']+)["']/i
      );

    const producerMatch =
      opening.match(
        /data-producer=["']([^"']+)["']/i
      );

    products.push({
      source:
        "pan_mysza",

      condition:
        "new",

      productId:
        starts[i]
          .productId,

      title,

      price:
        priceMatch
          ? parsePrice(
              priceMatch[1]
            )
          : null,

      rawPrice:
        priceMatch
          ? cleanText(
              priceMatch[0]
            )
          : null,

      currency:
        "PLN",

      available:
        null,

      stock:
        null,

      availabilityChecked:
        false,

      category:
        categoryMatch?.[1] ||
        null,

      producer:
        producerMatch?.[1] ||
        null,

      image:
        makePanAbsoluteUrl(
          image
        ),

      url:
        makePanAbsoluteUrl(
          url
        ),
    });
  }

  const unique =
    new Map();

  for (
    const product
    of products
  ) {
    const key =
      product.productId ||
      product.url;

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

async function getPanMyszaCatalog() {
  const base =
    "https://panmysza.pl/pl/c/Black-Library/686";

  const unique =
    new Map();

  let pagesFetched = 0;

  const MAX_PAGES = 30;

  for (
    let page = 1;
    page <= MAX_PAGES;
    page++
  ) {
    try {
      const url =
        page === 1
          ? base
          : `${base}/${page}`;

      const html =
        await fetchHtml(
          url,
          3600
        );

      const products =
        parsePanMyszaPage(
          html
        );

      let newProducts = 0;

      for (
        const product
        of products
      ) {
        const key =
          product.productId ||
          product.url;

        if (
          !unique.has(key)
        ) {
          unique.set(
            key,
            product
          );

          newProducts++;
        }
      }

      pagesFetched++;

      if (
        products.length === 0 ||
        newProducts === 0
      ) {
        break;
      }

      await sleep(80);

    } catch (error) {
      console.error(
        `Pan Mysza page ${page}:`,
        error.message
      );

      break;
    }
  }

  return {
    items: [
      ...unique.values(),
    ],

    pagesFetched,
  };
}

/*
  ============================================================
  PAN MYSZA - STRONA PRODUKTU
  ============================================================
*/

function parsePanProductAvailability(
  html
) {
  const text =
    normalize(
      cleanText(html)
    );

  const stockPatterns = [
    /ilosc sztuk w magazynie\s*:?\s*(\d+)/i,
    /stan magazynowy\s*:?\s*(\d+)/i,
    /dostepna ilosc\s*:?\s*(\d+)/i,
  ];

  for (
    const pattern
    of stockPatterns
  ) {
    const match =
      text.match(pattern);

    if (match) {
      const stock =
        Number(
          match[1]
        );

      return {
        available:
          stock > 0,

        stock,

        reason:
          "stock_count",
      };
    }
  }

  if (
    text.includes(
      "towar niedostepny"
    ) ||
    text.includes(
      "produkt niedostepny"
    ) ||
    text.includes(
      "powiadom o dostepnosci"
    )
  ) {
    return {
      available:
        false,

      stock:
        0,

      reason:
        "product_unavailable",
    };
  }

  if (
    text.includes(
      "do koszyka"
    )
  ) {
    return {
      available:
        true,

      stock:
        null,

      reason:
        "cart_available",
    };
  }

  return {
    available:
      null,

    stock:
      null,

    reason:
      "unknown",
  };
}

async function checkPanOfferAvailability(
  offer
) {
  try {
    const html =
      await fetchHtml(
        offer.url,
        300
      );

    const status =
      parsePanProductAvailability(
        html
      );

    return {
      ...offer,

      available:
        status.available,

      stock:
        status.stock,

      availabilityChecked:
        true,

      availabilitySource:
        "product_page",

      availabilityReason:
        status.reason,
    };

  } catch (error) {
    return {
      ...offer,

      available:
        null,

      availabilityChecked:
        false,

      availabilitySource:
        "product_page",

      availabilityReason:
        "fetch_error",

      availabilityError:
        error.message,
    };
  }
}

/*
  ============================================================
  DOPASOWYWANIE KATALOGU
  ============================================================
*/

function findCatalogOffers(
  book,
  catalog,
  minimumScore = 65
) {
  const matches = [];

  for (
    const product
    of catalog
  ) {
    const score =
      trustedCatalogBookScore(
        book,
        product.title
      );

    if (
      score >=
      minimumScore
    ) {
      matches.push({
        ...product,

        matchScore:
          Math.round(
            score
          ),
      });
    }
  }

  return matches
    .sort(
      (a, b) => {
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
      }
    )
    .slice(
      0,
      15
    );
}

function mergeOffers(
  first,
  second
) {
  const unique =
    new Map();

  for (
    const offer
    of [
      ...first,
      ...second,
    ]
  ) {
    const key =
      offer.productId
        ? `id:${offer.productId}`
        : `url:${offer.url}`;

    if (
      !unique.has(key)
    ) {
      unique.set(
        key,
        offer
      );

      continue;
    }

    const old =
      unique.get(key);

    unique.set(
      key,
      {
        ...offer,
        ...old,

        price:
          old.price ??
          offer.price,

        image:
          old.image ??
          offer.image,

        productId:
          old.productId ??
          offer.productId,
      }
    );
  }

  return [
    ...unique.values(),
  ];
}

/*
  ============================================================
  POJEDYNCZA KSIĄŻKA
  ============================================================
*/

async function findBook(
  book,
  hegemonCatalog,
  panCatalog
) {
  /*
    ========================================================
    ALLEGRO LOKALNIE
    ========================================================
  */

  let allegroOffers = [];
  let allegroError = null;

  try {
    const raw =
      await searchLokalnie(
        book.originalTitle
      );

    for (
      const offer
      of raw
    ) {
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

  allegroOffers = [
    ...allegroUnique.values(),
  ];

  allegroOffers.sort(
    (a, b) => {
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
    }
  );

  /*
    ========================================================
    HEGEMON - KATALOG
    ========================================================
  */

  let rawHegemonOffers =
    findCatalogOffers(
      book,
      hegemonCatalog,
      65
    );

  let hegemonSearchUsed =
    false;

  let hegemonSearchError =
    null;

  /*
    Jeżeli katalog nie zwrócił książki,
    próbujemy wyszukiwarki Hegemona.
  */

  if (
    rawHegemonOffers.length === 0
  ) {
    hegemonSearchUsed =
      true;

    const search =
      await searchHegemon(
        book.originalTitle
      );

    hegemonSearchError =
      search.error;

    const searchMatches =
      findCatalogOffers(
        book,
        search.products,
        65
      );

    rawHegemonOffers =
      mergeOffers(
        rawHegemonOffers,
        searchMatches
      );
  }

  /*
    Dla znalezionych ofert
    sprawdzamy stronę produktu.
  */

  const hegemonOffers = [];

  for (
    const offer
    of rawHegemonOffers
  ) {
    const resolved =
      await checkHegemonOfferAvailability(
        offer
      );

    hegemonOffers.push(
      resolved
    );

    await sleep(75);
  }

  /*
    ========================================================
    PAN MYSZA
    ========================================================
  */

  const rawPanOffers =
    findCatalogOffers(
      book,
      panCatalog,
      65
    );

  const panOffers = [];

  for (
    const offer
    of rawPanOffers
  ) {
    const resolved =
      await checkPanOfferAvailability(
        offer
      );

    panOffers.push(
      resolved
    );

    await sleep(75);
  }

  /*
    ========================================================
    NAJLEPSZE CENY
    ========================================================
  */

  const cheapestAllegro =
    cheapest(
      allegroOffers
    );

  const cheapestHegemon =
    cheapestAvailable(
      hegemonOffers
    );

  const cheapestPan =
    cheapestAvailable(
      panOffers
    );

  const newCandidates = [
    cheapestHegemon,
    cheapestPan,
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

  const bestUsed =
    cheapestAllegro;

  return {
    ...book,

    found:
      allegroOffers.length > 0 ||
      hegemonOffers.length > 0 ||
      panOffers.length > 0,

    sources: {
      allegro_lokalnie: {
        found:
          allegroOffers.length > 0,

        error:
          allegroError,

        offerCount:
          allegroOffers.length,

        availableOfferCount:
          allegroOffers.filter(
            (offer) =>
              offer.available ===
              true
          ).length,

        lowestPrice:
          cheapestAllegro
            ?.price ??
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

        searchFallbackUsed:
          hegemonSearchUsed,

        searchFallbackError:
          hegemonSearchError,

        offerCount:
          hegemonOffers.length,

        availableOfferCount:
          hegemonOffers.filter(
            (offer) =>
              offer.available ===
              true
          ).length,

        unknownAvailabilityCount:
          hegemonOffers.filter(
            (offer) =>
              offer.available == null
          ).length,

        unavailableOfferCount:
          hegemonOffers.filter(
            (offer) =>
              offer.available ===
              false
          ).length,

        lowestPrice:
          cheapestHegemon
            ?.price ??
          null,

        offers:
          hegemonOffers,
      },

      pan_mysza: {
        found:
          panOffers.length > 0,

        offerCount:
          panOffers.length,

        availableOfferCount:
          panOffers.filter(
            (offer) =>
              offer.available ===
              true
          ).length,

        unknownAvailabilityCount:
          panOffers.filter(
            (offer) =>
              offer.available == null
          ).length,

        unavailableOfferCount:
          panOffers.filter(
            (offer) =>
              offer.available ===
              false
          ).length,

        lowestPrice:
          cheapestPan
            ?.price ??
          null,

        offers:
          panOffers,
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
  ============================================================
  API
  ============================================================
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
      Nadal max 3 książki na jedno wywołanie.
      Dzięki temu nie przeciążamy Allegro
      ani sklepów.
    */

    limit =
      Math.min(
        limit,
        3
      );

    /*
      Katalog Hegemona i Pan Mysza
      pobieramy równolegle.
    */

    const [
      hegemonResult,
      panResult,
    ] =
      await Promise.all([
        getHegemonCatalog(),
        getPanMyszaCatalog(),
      ]);

    const hegemonCatalog =
      hegemonResult.items;

    const panCatalog =
      panResult.items;

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
          panCatalog
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
          apiVersion:
            API_VERSION,

          updatedAt:
            new Date()
              .toISOString(),

          sources: [
            "allegro_lokalnie",
            "hegemon",
            "pan_mysza",
          ],

          totalBooks:
            BOOKS.length,

          catalogStats: {
            /*
              Hegemon deklaruje więcej
              pozycji niż faktycznie renderuje
              w HTML kategorii.

              Dlatego rozdzielamy te liczby.
            */

            hegemonRendered:
              hegemonCatalog.length,

            hegemonDeclared:
              hegemonResult
                .declaredTotal,

            hegemonPagesFetched:
              hegemonResult
                .pagesFetched,

            /*
              Dla zgodności ze starszym
              frontendem zachowujemy też
              zwykłe "hegemon".
            */

            hegemon:
              hegemonCatalog.length,

            pan_mysza:
              panCatalog.length,

            panMyszaPages:
              panResult
                .pagesFetched,
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
    console.error(
      "books API:",
      error
    );

    return new Response(
      JSON.stringify(
        {
          apiVersion:
            API_VERSION,

          error:
            "Multi-source search failed",

          details:
            error.message,
        },
        null,
        2
      ),

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
