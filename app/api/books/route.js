import { BOOKS } from "../../../lib/books.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cleanText(value) {
  return value
    ?.replace(/<[^>]+>/g, "")
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

  const cleaned = value
    .replace(/[^\d,.]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");

  const price = Number.parseFloat(cleaned);

  return Number.isFinite(price) ? price : null;
}

function isProbablySameBook(foundTitle, wantedTitles) {
  const found = normalize(foundTitle);

  return wantedTitles.some((wantedTitle) => {
    const wanted = normalize(wantedTitle);

    if (!wanted) return false;

    return (
      found === wanted ||
      found.includes(wanted) ||
      wanted.includes(found)
    );
  });
}

async function amazonSearch(query) {
  const url =
    "https://www.amazon.pl/s?k=" +
    encodeURIComponent(query) +
    "&i=stripbooks";

  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/140.0.0.0 Safari/537.36",

      "Accept-Language": "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7",

      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Amazon HTTP ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const html = new TextDecoder("utf-8").decode(buffer);

  if (
    html.includes("Enter the characters you see below") ||
    html.includes("Wprowadź znaki") ||
    html.includes("api-services-support@amazon.com")
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

    const asin = asinMatch[1];

    const titleMatch =
      block.match(
        /<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i
      ) ||
      block.match(
        /<span[^>]+class=["'][^"']*a-size-medium[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
      );

    if (!titleMatch) continue;

    const title = cleanText(titleMatch[1]);

    const priceMatch = block.match(
      /<span[^>]+class=["'][^"']*a-offscreen[^"']*["'][^>]*>([^<]+)<\/span>/i
    );

    const rawPrice = priceMatch
      ? cleanText(priceMatch[1])
      : null;

    const imageMatch = block.match(
      /<img[^>]+class=["'][^"']*s-image[^"']*["'][^>]+src=["']([^"']+)["']/i
    );

    results.push({
      asin,
      amazonTitle: title,
      price: parsePrice(rawPrice),
      rawPrice,
      currency: "PLN",
      image: imageMatch?.[1] || null,
      url: `https://www.amazon.pl/dp/${asin}`,
    });
  }

  return results;
}

async function findBook(book) {
  const searchTerms = book.searchTerms || [
    book.polishTitle,
    book.originalTitle,
  ].filter(Boolean);

  for (const term of searchTerms) {
    try {
      const results = await amazonSearch(term);

      const match = results.find((result) =>
        isProbablySameBook(
          result.amazonTitle,
          searchTerms
        )
      );

      if (match) {
        return {
          ...book,
          found: true,
          searchedFor: term,
          ...match,
        };
      }
    } catch (error) {
      if (error.message === "Amazon CAPTCHA") {
        throw error;
      }
    }

    // mała przerwa między wyszukiwaniami
    await new Promise((resolve) =>
      setTimeout(resolve, 700)
    );
  }

  return {
    ...book,
    found: false,
    asin: null,
    amazonTitle: null,
    price: null,
    currency: "PLN",
    image: null,
    url: null,
  };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    let offset = Number(
      searchParams.get("offset") || 0
    );

    let limit = Number(
      searchParams.get("limit") || 5
    );

    if (!Number.isInteger(offset) || offset < 0) {
      offset = 0;
    }

    if (!Number.isInteger(limit) || limit < 1) {
      limit = 5;
    }

    // żeby przypadkiem nie odpalić setek zapytań
    limit = Math.min(limit, 10);

    const selectedBooks = BOOKS.slice(
      offset,
      offset + limit
    );

    const results = [];

    for (const book of selectedBooks) {
      const result = await findBook(book);

      results.push(result);

      await new Promise((resolve) =>
        setTimeout(resolve, 900)
      );
    }

    const nextOffset =
      offset + selectedBooks.length;

    return Response.json(
      {
        updatedAt: new Date().toISOString(),

        totalBooks: BOOKS.length,

        offset,
        limit,

        processed: results.length,

        found: results.filter(
          (book) => book.found
        ).length,

        nextOffset:
          nextOffset < BOOKS.length
            ? nextOffset
            : null,

        finished:
          nextOffset >= BOOKS.length,

        books: results,
      },
      {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    return Response.json(
      {
        error: "Amazon search failed",
        details: error.message,
      },
      {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}
