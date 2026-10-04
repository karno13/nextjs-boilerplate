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
  if (!value) return null;

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

/*
  ============================================================
  DOPASOWANIE TYTUŁÓW
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
    .filter((word) => word.length > 2);

  const foundWords = b
    .split(" ")
    .filter(Boolean);

  if (!wantedWords.length) {
    return 0;
  }

  if (wantedWords.length === 1) {
    const word = wantedWords[0];

    if (!foundWords.includes(word)) {
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
    for (const term of book.searchTerms) {
      if (!term) continue;

      scores.push(
        scoreMatch(
          term,
          title
        )
      );
    }
  }

  if (!scores.length) {
    return 0;
  }

  return Math.max(...scores);
}

/*
  ============================================================
  MATCHER DLA HEGEMON / PAN MYSZA
  ============================================================
*/

function trustedCatalogBookScore(book, title) {
  const normalTitle =
    normalize(title);

  const candidates = [
    book.originalTitle,
    book.polishTitle,
    ...(Array.isArray(book.searchTerms)
      ? book.searchTerms
      : []),
  ]
    .filter(Boolean)
    .map(normalize);

  let best = 0;

  for (const candidate of candidates) {
    if (!candidate) continue;

    const wantedWords =
      candidate
        .split(" ")
        .filter(
          (word) =>
            word.length > 2
        );

    if (wantedWords.length > 1) {
      best =
        Math.max(
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

    if (!wanted) {
      continue;
    }

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

    const meaningfulOtherWords =
      foundWords.filter(
        (word) =>
          word !== wanted &&
          !harmlessWords.has(word)
      );

    if (
      meaningfulOtherWords.length ===
      0
    ) {
      best =
        Math.max(
          best,
          95
        );
    } else {
      best =
        Math.max(
          best,
          55
        );
    }
  }

  return best;
}

/*
  ============================================================
  FETCH
  ============================================================
*/

async function fetchHtml(url) {
  const response =
    await fetch(url, {
      next: {
        revalidate: 3600,
      },

      headers: HEADERS,

      redirect: "follow",
    });

  if (
    response.status === 429
  ) {
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
          a.price -
          b.price
      )[0] || null
  );
}

function cheapestAvailable(offers) {
  return (
    offers
      .filter(
        (offer) =>
          offer.price != null &&
          offer.available === true
      )
      .sort(
        (a, b) =>
          a.price -
          b.price
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

  let hasBookContext = false;

  for (
    const context
    of positiveContext
  ) {
    if (
      text.includes(
        normalize(context)
      )
    ) {
      hasBookContext = true;
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

async function searchLokalnie(query) {
  const url =
    "https://allegrolokalnie.pl/oferty/q/" +
    encodeURIComponent(query);

  const response =
    await fetch(url, {
      next: {
        revalidate: 3600,
      },

      headers: HEADERS,
    });

  if (
    response.status === 429
  ) {
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
  HEGEMON - PARSER KATALOGU
  ============================================================
*/

function parseHegemonPage(html) {
  const products = [];

  const titleRegex =
    /<h2[^>]*class=["'][^"']*product-title[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while (
    (match =
      titleRegex.exec(html)) !==
    null
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

    let available =
      null;

    if (stock != null) {
      available =
        stock > 0;
    }

    /*
      Możemy czasem rozstrzygnąć dostępność
      już z karty katalogowej.
    */

    if (
      /product-flag\s+out_of_stock/i.test(
        around
      ) ||
      /Obecnie niedostępny/i.test(
        around
      )
    ) {
      available = false;
    }

    if (
      /product-flag\s+in_stock/i.test(
        around
      )
    ) {
      available = true;
    }

    products.push({
      source:
        "hegemon",

      condition:
        "new",

      title,

      price,

      rawPrice:
        priceMatch?.[0] ||
        null,

      currency:
        "PLN",

      stock,

      available,

      availabilityChecked:
        false,

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

  for (
    const pattern
    of patterns
  ) {
    const match =
      html.match(pattern);

    if (match) {
      const total =
        Number(
          match[1]
        );

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
        `Hegemon page ${page}:`,
        error.message
      );
    }
  }

  const unique =
    new Map();

  for (
    const item
    of all
  ) {
    const key =
      item.url ||
      normalize(
        item.title
      );

    if (
      !unique.has(key)
    ) {
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
  ============================================================
  HEGEMON - DOKŁADNE SPRAWDZENIE STRONY PRODUKTU
  ============================================================
*/

function parseHegemonProductAvailability(
  html
) {
  /*
    Najpewniejszy sygnał:
    schema.org/Offer
  */

  if (
    /schema\.org\/OutOfStock/i.test(
      html
    )
  ) {
    return {
      available: false,
      stock: null,
      reason:
        "schema_out_of_stock",
    };
  }

  if (
    /schema\.org\/InStock/i.test(
      html
    )
  ) {
    const stockMatch =
      html.match(
        /data-stock=["'](\d+)["']/i
      ) ||
      html.match(
        /Na stanie\s*:?\s*(\d+)\s*szt/i
      );

    return {
      available: true,

      stock:
        stockMatch
          ? Number(
              stockMatch[1]
            )
          : null,

      reason:
        "schema_in_stock",
    };
  }

  /*
    Drugi mocny sygnał:
    komunikat Hegemona.
  */

  if (
    /product-unavailable/i.test(
      html
    ) ||
    /Obecnie niedostępny/i.test(
      html
    )
  ) {
    return {
      available: false,
      stock: null,
      reason:
        "product_unavailable",
    };
  }

  const stockMatch =
    html.match(
      /data-stock=["'](\d+)["']/i
    ) ||
    html.match(
      /Na stanie\s*:?\s*(\d+)\s*szt/i
    );

  if (stockMatch) {
    const stock =
      Number(
        stockMatch[1]
      );

    return {
      available:
        stock > 0,

      stock,

      reason:
        "stock_count",
    };
  }

  /*
    Aktywny przycisk "Dodaj do koszyka"
    też jest użyteczny.

    Uwaga:
    sprawdzamy, czy button nie ma disabled.
  */

  const cartButtonMatch =
    html.match(
      /<button[^>]*class=["'][^"']*add-to-cart[^"']*["'][^>]*>/i
    );

  if (cartButtonMatch) {
    const button =
      cartButtonMatch[0];

    if (
      /\bdisabled\b/i.test(
        button
      )
    ) {
      return {
        available: false,
        stock: null,
        reason:
          "cart_disabled",
      };
    }

    return {
      available: true,
      stock: null,
      reason:
        "cart_enabled",
    };
  }

  return {
    available: null,
    stock: null,
    reason:
      "unknown",
  };
}

async function checkHegemonOfferAvailability(
  offer
) {
  /*
    Jeśli katalog już dał nam pewną
    dostępność, nie robimy dodatkowego requestu.
  */

  if (
    offer.available === true ||
    offer.available === false
  ) {
    return {
      ...offer,

      availabilityChecked:
        true,

      availabilityReason:
        "catalog",
    };
  }

  try {
    const html =
      await fetchHtml(
        offer.url
      );

    const status =
      parseHegemonProductAvailability(
        html
      );

    return {
      ...offer,

      available:
        status.available,

      stock:
        status.stock ??
        offer.stock,

      availabilityChecked:
        true,

      availabilityReason:
        status.reason,
    };

  } catch (error) {
    return {
      ...offer,

      availabilityChecked:
        false,

      availabilityError:
        error.message,
    };
  }
}

/*
  ============================================================
  PAN MYSZA
  ============================================================
*/

function makePanAbsoluteUrl(
  value
) {
  if (!value) {
    return null;
  }

  if (
    value.startsWith(
      "https://"
    ) ||
    value.startsWith(
      "http://"
    )
  ) {
    return value;
  }

  if (
    value.startsWith("//")
  ) {
    return (
      "https:" +
      value
    );
  }

  if (
    value.startsWith("/")
  ) {
    return (
      "https://panmysza.pl" +
      value
    );
  }

  return (
    "https://panmysza.pl/" +
    value
  );
}

function getPanPageCount(html) {
  const regex =
    /href=["'][^"']*\/pl\/c\/Black-Library\/686\/(\d+)[^"']*["']/gi;

  let maxPage = 1;
  let match;

  while (
    (match =
      regex.exec(html)) !==
    null
  ) {
    const page =
      Number(
        match[1]
      );

    if (
      Number.isFinite(page) &&
      page > maxPage
    ) {
      maxPage =
        page;
    }
  }

  return Math.min(
    Math.max(
      maxPage,
      1
    ),
    25
  );
}

function parsePanMyszaPage(html) {
  const products = [];

  const startRegex =
    /<div\b[^>]*data-product-id=["']([^"']+)["'][^>]*>/gi;

  const starts = [];

  let startMatch;

  while (
    (startMatch =
      startRegex.exec(html)) !==
    null
  ) {
    starts.push({
      index:
        startMatch.index,

      productId:
        startMatch[1],
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

    const firstLink =
      block.match(
        /<a[^>]+href=["']([^"']*\/pl\/p\/[^"']+)["'][^>]*title=["']([^"']+)["'][^>]*>/i
      );

    const secondLink =
      block.match(
        /<a[^>]+title=["']([^"']+)["'][^>]*href=["']([^"']*\/pl\/p\/[^"']+)["'][^>]*>/i
      );

    let url = null;
    let title = null;

    if (firstLink) {
      url =
        firstLink[1];

      title =
        firstLink[2];

    } else if (
      secondLink
    ) {
      title =
        secondLink[1];

      url =
        secondLink[2];
    }

    if (!url) {
      const hrefMatch =
        block.match(
          /href=["']([^"']*\/pl\/p\/[^"']+)["']/i
        );

      url =
        hrefMatch?.[1] ||
        null;
    }

    if (!title) {
      const titleMatch =
        block.match(
          /class=["'][^"']*productname[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i
        );

      title =
        titleMatch
          ? cleanText(
              titleMatch[1]
            )
          : null;
    }

    if (!title) {
      const altMatch =
        block.match(
          /<img[^>]+alt=["']([^"']+)["']/i
        );

      title =
        altMatch
          ? cleanText(
              altMatch[1]
            )
          : null;
    }

    title =
      cleanText(
        title || ""
      );

    if (
      !url ||
      !title ||
      title.length < 3
    ) {
      continue;
    }

    url =
      makePanAbsoluteUrl(
        url
      );

    const priceMatch =
      block.match(
        /<em[^>]*>\s*(\d[\d\s]*[,.]\d{2})[\s\S]*?<\/em>/i
      );

    const price =
      priceMatch
        ? parsePrice(
            priceMatch[1]
          )
        : null;

    const blockText =
      normalize(
        cleanText(block)
      );

    const hasNotify =
      blockText.includes(
        "powiadom o dostepnosci"
      ) ||
      blockText.includes(
        "powiadom o dost"
      );

    const hasCart =
      blockText.includes(
        "do koszyka"
      );

    let available =
      null;

    if (hasNotify) {
      available =
        false;
    } else if (hasCart) {
      available =
        true;
    }

    const dataSrcMatch =
      block.match(
        /<img[^>]+data-src=["']([^"']+)["']/i
      );

    const srcMatch =
      block.match(
        /<img[^>]+src=["']([^"']+)["']/i
      );

    let image =
      dataSrcMatch?.[1] ||
      srcMatch?.[1] ||
      null;

    if (
      image &&
      image.startsWith(
        "data:image"
      )
    ) {
      image = null;
    }

    image =
      makePanAbsoluteUrl(
        image
      );

    const openingTag =
      block.slice(
        0,
        Math.min(
          block.length,
          1000
        )
      );

    const categoryMatch =
      openingTag.match(
        /data-category=["']([^"']+)["']/i
      );

    const producerMatch =
      openingTag.match(
        /data-producer=["']([^"']+)["']/i
      );

    products.push({
      source:
        "pan_mysza",

      condition:
        "new",

      title,

      price,

      rawPrice:
        priceMatch?.[0]
          ? cleanText(
              priceMatch[0]
            )
          : null,

      currency:
        "PLN",

      available,

      stock:
        null,

      productId:
        starts[i]
          .productId,

      category:
        categoryMatch?.[1] ||
        null,

      producer:
        producerMatch?.[1] ||
        null,

      image,

      url,
    });
  }

  const unique =
    new Map();

  for (
    const item
    of products
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

async function getPanMyszaCatalog() {
  const base =
    "https://panmysza.pl/pl/c/Black-Library/686";

  const firstHtml =
    await fetchHtml(base);

  const pageCount =
    getPanPageCount(
      firstHtml
    );

  const all = [
    ...parsePanMyszaPage(
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
          `${base}/${page}`
        );

      all.push(
        ...parsePanMyszaPage(
          html
        )
      );

      await sleep(120);

    } catch (error) {
      console.error(
        `Pan Mysza page ${page}:`,
        error.message
      );
    }
  }

  const unique =
    new Map();

  for (
    const item
    of all
  ) {
    const key =
      item.url ||
      item.productId ||
      normalize(
        item.title
      );

    if (
      !unique.has(key)
    ) {
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
  ============================================================
  DOPASOWYWANIE KATALOGÓW
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

        const aAvailability =
          a.available === true
            ? 2
            : a.available == null
              ? 1
              : 0;

        const bAvailability =
          b.available === true
            ? 2
            : b.available == null
              ? 1
              : 0;

        if (
          aAvailability !==
          bAvailability
        ) {
          return (
            bAvailability -
            aAvailability
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
    ALLEGRO LOKALNIE
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
  );

  /*
    HEGEMON
  */

  let hegemonOffers =
    findCatalogOffers(
      book,
      hegemonCatalog,
      65
    );

  /*
    Dociągamy stronę produktu TYLKO
    dla ofert z nieznaną dostępnością.
  */

  const resolvedHegemonOffers = [];

  for (
    const offer
    of hegemonOffers
  ) {
    if (
      offer.available == null
    ) {
      const resolved =
        await checkHegemonOfferAvailability(
          offer
        );

      resolvedHegemonOffers.push(
        resolved
      );

      await sleep(100);

    } else {
      resolvedHegemonOffers.push(
        offer
      );
    }
  }

  hegemonOffers =
    resolvedHegemonOffers;

  /*
    PAN MYSZA
  */

  const panOffers =
    findCatalogOffers(
      book,
      panCatalog,
      65
    );

  /*
    NAJTAŃSZE
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

    limit =
      Math.min(
        limit,
        3
      );

    const [
      hegemonCatalog,
      panCatalog,
    ] =
      await Promise.all([
        getHegemonCatalog(),
        getPanMyszaCatalog(),
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
            hegemon:
              hegemonCatalog.length,

            pan_mysza:
              panCatalog.length,
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
