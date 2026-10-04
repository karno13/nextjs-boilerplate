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
  HELPERY
  ============================================
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

  const match =
    String(value).match(
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

  const wantedWords =
    a
      .split(" ")
      .filter(
        (word) =>
          word.length > 2
      );

  if (!wantedWords.length) {
    return 0;
  }

  const foundWords =
    new Set(
      b.split(" ")
    );

  let matches = 0;

  for (const word of wantedWords) {
    if (
      foundWords.has(word)
    ) {
      matches++;
    }
  }

  return (
    matches /
    wantedWords.length
  ) * 100;
}

function bestBookScore(book, title) {
  const scores = [
    scoreMatch(
      book.originalTitle,
      title
    ),
  ];

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
      scores.push(
        scoreMatch(
          term,
          title
        )
      );
    }
  }

  return Math.max(...scores);
}

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

function cheapestAvailable(offers) {
  return (
    offers
      .filter(
        (offer) =>
          offer.price != null &&
          offer.available !== false
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
    normalize(
      result.title
    );

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
      results.length >= 50
    ) {
      break;
    }
  }

  const unique =
    new Map();

  for (const item of results) {
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

  for (
    const pattern
    of patterns
  ) {
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
  ============================================
  PAN MYSZA
  ============================================

  Kategoria:
  https://panmysza.pl/pl/c/Black-Library/686

  Kolejne strony:
  /686/2
  /686/3
  itd.
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
      Number(match[1]);

    if (
      Number.isFinite(page) &&
      page > maxPage
    ) {
      maxPage = page;
    }
  }

  /*
    Ochrona przed przypadkowym
    złapaniem absurdalnej liczby.
  */

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

  /*
    Szukamy początków kart:
    <div data-product-id="...">
  */

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
        ? starts[i + 1].index
        : Math.min(
            html.length,
            start + 15000
          );

    const block =
      html.slice(
        start,
        end
      );

    /*
      Link produktu.
      W Shoperze ma format:
      /pl/p/Tytul/12345
    */

    const linkMatch =
      block.match(
        /<a[^>]+href=["']([^"']*\/pl\/p\/[^"']+)["'][^>]*title=["']([^"']+)["'][^>]*>/i
      ) ||
      block.match(
        /<a[^>]+title=["']([^"']+)["'][^>]*href=["']([^"']*\/pl\/p\/[^"']+)["'][^>]*>/i
      );

    let url = null;
    let title = null;

    if (linkMatch) {
      /*
        Obsługujemy obie kolejności
        atrybutów.
      */

      if (
        linkMatch[1]
          .includes(
            "/pl/p/"
          )
      ) {
        url =
          linkMatch[1];

        title =
          linkMatch[2];
      } else {
        title =
          linkMatch[1];

        url =
          linkMatch[2];
      }
    }

    /*
      Awaryjnie osobno href + title.
    */

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

    /*
      Cena jest zwykle:
      <em>44,00 zł</em>

      Nie polegamy na samym napisie "zł",
      bo w debug HTML mieliśmy mojibake:
      zÅ‚.
    */

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

    /*
      Dostępność:
      - Do koszyka = dostępne
      - Powiadom o dostępności = brak
    */

    const hasNotify =
      /Powiadom\s+o\s+dostępności/i.test(
        block
      ) ||
      /Powiadom\s+o\s+dost/i.test(
        cleanText(block)
      );

    const hasCart =
      /Do\s+koszyka/i.test(
        cleanText(block)
      );

    let available =
      null;

    if (hasNotify) {
      available = false;
    } else if (hasCart) {
      available = true;
    }

    /*
      Obraz.
      Priorytet data-src, bo Pan Mysza
      używa lazy-load.
    */

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

    /*
      Ignorujemy 1px placeholder.
    */

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

    /*
      Kategoria / producent z atrybutów
      karty produktu.
    */

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

  /*
    Deduplikacja po URL.
  */

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

      const products =
        parsePanMyszaPage(
          html
        );

      all.push(
        ...products
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

  for (
    const product
    of catalog
  ) {
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
    .sort(
      (a, b) => {
        /*
          Najpierw najlepsze
          dopasowanie.
        */

        if (
          b.matchScore !==
          a.matchScore
        ) {
          return (
            b.matchScore -
            a.matchScore
          );
        }

        /*
          Przy tym samym wyniku
          dostępne przed niedostępnymi.
        */

        if (
          a.available === true &&
          b.available === false
        ) {
          return -1;
        }

        if (
          a.available === false &&
          b.available === true
        ) {
          return 1;
        }

        /*
          Następnie cena.
        */

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
  ============================================
  POJEDYNCZA KSIĄŻKA
  ============================================
*/

async function findBook(
  book,
  hegemonCatalog,
  panCatalog
) {
  /*
    ALLEGRO LOKALNIE
  */

  let allegroOffers =
    [];

  let allegroError =
    null;

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
    PAN MYSZA
  */

  const panOffers =
    findCatalogOffers(
      book,
      panCatalog,
      65
    );

  /*
    Najtańsze.
  */

  const cheapestAllegro =
    cheapestAvailable(
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

  /*
    NOWE:
    nie bierzemy Pan Mysza,
    jeśli available === false.
  */

  const newCandidates = [
    cheapestHegemon,
    cheapestPan,
  ]
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.price - b.price
    );

  const bestNew =
    newCandidates[0] ||
    null;

  /*
    UŻYWANE.
  */

  const usedCandidates = [
    cheapestAllegro,
  ]
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.price - b.price
    );

  const bestUsed =
    usedCandidates[0] ||
    null;

  return {
    ...book,

    found:
      allegroOffers.length > 0 ||
      hegemonOffers.length > 0 ||
      panOffers.length > 0,

    sources: {
      /*
        --------------------------
        ALLEGRO LOKALNIE
        --------------------------
      */

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
              offer.available !==
              false
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

      /*
        --------------------------
        HEGEMON
        --------------------------
      */

      hegemon: {
        found:
          hegemonOffers.length > 0,

        offerCount:
          hegemonOffers.length,

        availableOfferCount:
          hegemonOffers.filter(
            (offer) =>
              offer.available !==
              false
          ).length,

        lowestPrice:
          cheapestHegemon
            ?.price ??
          null,

        offers:
          hegemonOffers,
      },

      /*
        --------------------------
        PAN MYSZA
        --------------------------
      */

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

        unavailableOfferCount:
          panOffers.filter(
            (offer) =>
              offer.available ===
              false
          ).length,

        lowestPrice:
          cheapestPan?.price ??
          null,

        offers:
          panOffers,
      },
    },

    /*
      Podsumowanie.
    */

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
      Nie więcej niż 3 książki
      na jedno wywołanie,
      ze względu na Allegro Lokalnie.
    */

    limit =
      Math.min(
        limit,
        3
      );

    /*
      Hegemon oraz Pan Mysza
      pobieramy równolegle.

      Dzięki next.revalidate=3600
      kolejne requesty powinny
      korzystać z cache Vercela.
    */

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

      /*
        Pauza głównie dla
        Allegro Lokalnie.
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
