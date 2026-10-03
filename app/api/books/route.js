import { BOOKS } from "../../../lib/books.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    "Często sprzedaje",
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
    /(\d[\d\s]*(?:[,.]\d{2})?)/
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

  const foundWords = new Set(
    b.split(" ")
  );

  if (!words.length) {
    return 0;
  }

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

  const html = await response.text();

  const results = [];

  const linkRegex =
    /href=["'](\/oferta\/[^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const relativeUrl = match[1];
    const anchorHtml = match[2];

    const fullText =
      cleanText(anchorHtml);

    let priceMatch =
      fullText.match(
        /(?:Kup teraz|Licytacja)?\s*(\d[\d\s]*(?:[,.]\d{2})?)\s*zł/i
      );

    const around = html.slice(
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

async function findBook(book) {
  // Jedno zapytanie na książkę,
  // żeby ograniczyć rate limit.
  const query =
    book.originalTitle;

  const results =
    await searchLokalnie(
      query
    );

  const offers = [];

  for (const result of results) {
    const score =
      Math.max(
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

    if (score >= 60) {
      offers.push({
        ...result,

        matchScore:
          Math.round(score),
      });
    }
  }

  const uniqueOffers =
    new Map();

  for (const offer of offers) {
    if (
      !uniqueOffers.has(
        offer.url
      )
    ) {
      uniqueOffers.set(
        offer.url,
        offer
      );
    }
  }

  const finalOffers =
    [
      ...uniqueOffers.values(),
    ].sort((a, b) => {
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
    });

  return {
    ...book,

    searchedFor:
      query,

    found:
      finalOffers.length > 0,

    source:
      "allegro_lokalnie",

    offerCount:
      finalOffers.length,

    lowestPrice:
      finalOffers.find(
        (offer) =>
          offer.price != null
      )?.price ?? null,

    offers:
      finalOffers.slice(
        0,
        20
      ),
  };
}

export async function GET(
  request
) {
  try {
    const {
      searchParams,
    } = new URL(
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

    // Na razie maksymalnie 3 książki
    // w jednym wywołaniu.
    limit =
      Math.min(
        limit,
        3
      );

    const selected =
      BOOKS.slice(
        offset,
        offset + limit
      );

    const books = [];

    let rateLimited =
      false;

    for (
      const book
      of selected
    ) {
      try {
        const result =
          await findBook(
            book
          );

        books.push(
          result
        );
      } catch (error) {
        if (
          error.message.startsWith(
            "RATE_LIMITED"
          )
        ) {
          books.push({
            ...book,

            found: false,

            source:
              "allegro_lokalnie",

            error:
              error.message,
          });

          rateLimited =
            true;

          break;
        }

        books.push({
          ...book,

          found: false,

          source:
            "allegro_lokalnie",

          error:
            error.message,
        });
      }
    }

    const nextOffset =
      offset +
      books.length;

    const foundCount =
      books.filter(
        (book) =>
          book.found
      ).length;

    return new Response(
      JSON.stringify({
        updatedAt:
          new Date()
            .toISOString(),

        source:
          "allegro_lokalnie",

        totalBooks:
          BOOKS.length,

        offset,

        requested:
          limit,

        processed:
          books.length,

        found:
          foundCount,

        rateLimited,

        nextOffset:
          nextOffset <
          BOOKS.length
            ? nextOffset
            : null,

        finished:
          nextOffset >=
          BOOKS.length,

        books,
      }),

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
          "Allegro Lokalnie search failed",

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
