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
    /(\d{1,6}(?:[.,]\d{2})?)/
  );

  if (!match) return null;

  const number = Number(
    match[1].replace(",", ".")
  );

  return Number.isFinite(number)
    ? number
    : null;
}

function matchScore(wantedTitle, amazonTitle) {
  const wanted = normalize(wantedTitle);
  const found = normalize(amazonTitle);

  if (!wanted || !found) return 0;

  if (found === wanted) return 100;

  if (found.includes(wanted)) return 95;

  const wantedWords = wanted
    .split(" ")
    .filter((word) => word.length > 2);

  const foundWords = new Set(
    found.split(" ")
  );

  if (!wantedWords.length) return 0;

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

async function amazonSearch(query) {
  const searchUrl =
    "https://www.amazon.pl/s?k=" +
    encodeURIComponent(query) +
    "&i=stripbooks";

  const response = await fetch(searchUrl, {
    cache: "no-store",

    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/140.0.0.0 Safari/537.36",

      "Accept-Language":
        "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7",

      Accept:
        "text/html,application/xhtml+xml," +
        "application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Amazon HTTP ${response.status}`
    );
  }

  const buffer =
    await response.arrayBuffer();

  const html =
    new TextDecoder("utf-8").decode(
      buffer
    );

  if (
    html.includes(
      "Enter the characters you see below"
    ) ||
    html.includes("Wprowadź znaki") ||
    html.includes(
      "api-services-support@amazon.com"
    )
  ) {
    throw new Error("Amazon CAPTCHA");
  }

  const blocks =
    html.match(
      /<div[^>]+data-component-type=["']s-search-result["'][\s\S]*?(?=<div[^>]+data-component-type=["']s-search-result["']|$)/gi
    ) || [];

  const results = [];

  for (const block of blocks) {
    const asinMatch = block.match(
      /data-asin=["']([A-Z0-9]{10})["']/i
    );

    if (!asinMatch) continue;

    const titleMatch =
      block.match(
        /<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i
      ) ||
      block.match(
        /<span[^>]+class=["'][^"']*a-size-medium[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
      );

    if (!titleMatch) continue;

    const amazonTitle =
      cleanText(titleMatch[1]);

    const priceMatch =
      block.match(
        /<span[^>]+class=["'][^"']*a-offscreen[^"']*["'][^>]*>([^<]+)<\/span>/i
      );

    const rawPrice =
      priceMatch
        ? cleanText(priceMatch[1])
        : null;

    const imageMatch =
      block.match(
        /<img[^>]+class=["'][^"']*s-image[^"']*["'][^>]+src=["']([^"']+)["']/i
      );

    results.push({
      asin: asinMatch[1],

      amazonTitle,

      price: parsePrice(rawPrice),

      rawPrice,

      currency: "PLN",

      image:
        imageMatch?.[1] || null,

      url:
        `https://www.amazon.pl/dp/${asinMatch[1]}`,
    });
  }

  return results;
}

async function findBook(book) {
  // Najpierw używamy angielskiego tytułu.
  // Jest bardziej niezawodny dla Black Library.
  const queries = [
    `${book.originalTitle} Black Library`,
    `${book.originalTitle} Warhammer`,
    book.originalTitle,
  ];

  if (
    book.polishTitle &&
    book.polishTitle !== book.originalTitle
  ) {
    queries.push(book.polishTitle);
  }

  let debug = [];

  for (const query of queries) {
    const results =
      await amazonSearch(query);

    debug.push({
      query,
      resultCount: results.length,
      sample:
        results.slice(0, 3).map((r) => ({
          asin: r.asin,
          title: r.amazonTitle,
          price: r.price,
        })),
    });

    let best = null;
    let bestScore = 0;

    for (const result of results) {
      const score = matchScore(
        book.originalTitle,
        result.amazonTitle
      );

      if (score > bestScore) {
        bestScore = score;
        best = result;
      }
    }

    // 70% zgodności słów wystarczy
    if (best && bestScore >= 70) {
      return {
        ...book,

        found: true,

        searchedFor: query,

        matchScore:
          Math.round(bestScore),

        ...best,

        debug,
      };
    }

    await sleep(800);
  }

  return {
    ...book,

    found: false,

    asin: null,
    amazonTitle: null,
    price: null,
    rawPrice: null,
    currency: "PLN",
    image: null,
    url: null,

    debug,
  };
}

export async function GET(request) {
  try {
    const { searchParams } =
      new URL(request.url);

    let offset = Number(
      searchParams.get("offset") || 0
    );

    let limit = Number(
      searchParams.get("limit") || 3
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
      limit = 3;
    }

    // Na razie max 5 podczas testów
    limit = Math.min(limit, 5);

    const selected =
      BOOKS.slice(
        offset,
        offset + limit
      );

    const books = [];

    for (const book of selected) {
      try {
        const result =
          await findBook(book);

        books.push(result);
      } catch (error) {
        books.push({
          ...book,
          found: false,
          error: error.message,
        });

        if (
          error.message ===
          "Amazon CAPTCHA"
        ) {
          break;
        }
      }

      await sleep(1000);
    }

    const nextOffset =
      offset + books.length;

    const body = JSON.stringify({
      updatedAt:
        new Date().toISOString(),

      totalBooks: BOOKS.length,

      offset,

      processed: books.length,

      found:
        books.filter(
          (book) => book.found
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
    });

    return new Response(body, {
      status: 200,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Access-Control-Allow-Origin":
          "*",

        "Cache-Control":
          "no-store",
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error:
          "Amazon search failed",

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
