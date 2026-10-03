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

  const match = value.match(/(\d[\d\s]*[,.]\d{2}|\d+)/);

  if (!match) return null;

  const cleaned = match[1]
    .replace(/\s/g, "")
    .replace(",", ".");

  const number = Number(cleaned);

  return Number.isFinite(number) ? number : null;
}

function scoreMatch(wantedTitle, foundTitle) {
  const wanted = normalize(wantedTitle);
  const found = normalize(foundTitle);

  if (!wanted || !found) return 0;

  if (wanted === found) return 100;

  if (found.includes(wanted)) return 95;

  const wantedWords = wanted
    .split(" ")
    .filter((word) => word.length > 2);

  const foundWords = new Set(found.split(" "));

  let matched = 0;

  for (const word of wantedWords) {
    if (foundWords.has(word)) {
      matched++;
    }
  }

  if (!wantedWords.length) return 0;

  return (matched / wantedWords.length) * 100;
}

async function searchAllegro(query) {
  const url =
    "https://allegro.pl/listing?string=" +
    encodeURIComponent(`"${query}"`);

  const response = await fetch(url, {
    cache: "no-store",

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
      `Allegro HTTP ${response.status}`
    );
  }

  const html = await response.text();

  const results = [];

  /*
    Allegro zmienia HTML dość często.
    Na początek wyciągamy linki ofert i tekst
    w ich najbliższym otoczeniu.
  */

  const linkRegex =
    /<a[^>]+href="(https:\/\/allegro\.pl\/oferta\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1];

    const title = cleanText(match[2]);

    if (!title || title.length < 3) {
      continue;
    }

    const around = html.slice(
      Math.max(0, match.index - 1500),
      Math.min(
        html.length,
        match.index + match[0].length + 2500
      )
    );

    const priceMatches =
      around.match(
        /\d[\d\s]*[,.]\d{2}\s*zł/g
      ) || [];

    const rawPrice =
      priceMatches.length
        ? priceMatches[0]
        : null;

    results.push({
      source: "allegro",
      title,
      price: parsePrice(rawPrice),
      rawPrice,
      currency: "PLN",
      url,
    });

    if (results.length >= 30) {
      break;
    }
  }

  // usuwamy duplikaty linków
  const unique = new Map();

  for (const item of results) {
    if (!unique.has(item.url)) {
      unique.set(item.url, item);
    }
  }

  return [...unique.values()];
}

async function findBook(book) {
  const queries = [
    book.originalTitle,
    book.polishTitle,
  ].filter(Boolean);

  let best = null;
  let bestScore = 0;
  let debug = [];

  for (const query of queries) {
    const results =
      await searchAllegro(query);

    debug.push({
      query,
      resultCount: results.length,
      sample: results
        .slice(0, 5)
        .map((r) => ({
          title: r.title,
          price: r.price,
          url: r.url,
        })),
    });

    for (const result of results) {
      const score = Math.max(
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

      if (score > bestScore) {
        bestScore = score;
        best = result;
      }
    }

    if (bestScore >= 70) {
      break;
    }
  }

  if (!best || bestScore < 70) {
    return {
      ...book,
      found: false,
      source: "allegro",
      debug,
    };
  }

  return {
    ...book,
    found: true,
    source: "allegro",
    matchScore: Math.round(bestScore),
    offer: best,
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
      searchParams.get("limit") || 1
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

    // na czas testów
    limit = Math.min(limit, 3);

    const selected = BOOKS.slice(
      offset,
      offset + limit
    );

    const books = [];

    for (const book of selected) {
      try {
        books.push(
          await findBook(book)
        );
      } catch (error) {
        books.push({
          ...book,
          found: false,
          source: "allegro",
          error: error.message,
        });
      }
    }

    const body = {
      updatedAt:
        new Date().toISOString(),

      source: "allegro",

      totalBooks: BOOKS.length,

      offset,

      processed: books.length,

      found: books.filter(
        (book) => book.found
      ).length,

      books,
    };

    return new Response(
      JSON.stringify(body),
      {
        headers: {
          "Content-Type":
            "application/json; charset=utf-8",

          "Access-Control-Allow-Origin":
            "*",

          "Cache-Control":
            "no-store",
        },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: "Allegro search failed",
        details: error.message,
      }),
      {
        status: 500,

        headers: {
          "Content-Type":
            "application/json; charset=utf-8",
        },
      }
    );
  }
}
