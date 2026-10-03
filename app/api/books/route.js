export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cleanText(value) {
  return value
    ?.replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function parsePrice(value) {
  if (!value) return null;

  const cleaned = value
    .replace(/[^\d,.]/g, "")
    .replace(",", ".");

  const price = Number.parseFloat(cleaned);

  return Number.isFinite(price) ? price : null;
}

async function searchAmazon(query) {
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

      "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",

      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Amazon HTTP ${response.status}`);
  }

  const html = await response.text();

  if (
    html.includes("Enter the characters you see below") ||
    html.includes("Wprowadź znaki") ||
    html.includes("api-services-support@amazon.com")
  ) {
    throw new Error("Amazon returned CAPTCHA");
  }

  const products = [];

  const blocks =
    html.match(
      /<div[^>]+data-component-type=["']s-search-result["'][\s\S]*?(?=<div[^>]+data-component-type=["']s-search-result["']|$)/gi
    ) || [];

  for (const block of blocks) {
    const asinMatch = block.match(/data-asin=["']([A-Z0-9]{10})["']/i);

    if (!asinMatch) continue;

    const asin = asinMatch[1];

    const titleMatch =
      block.match(
        /<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i
      ) ||
      block.match(
        /<span[^>]+class=["'][^"']*a-size-medium[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
      );

    const priceMatch =
      block.match(
        /<span[^>]+class=["'][^"']*a-offscreen[^"']*["'][^>]*>([^<]+)<\/span>/i
      );

    const imageMatch =
      block.match(
        /<img[^>]+class=["'][^"']*s-image[^"']*["'][^>]+src=["']([^"']+)["']/i
      );

    const title = titleMatch
      ? cleanText(titleMatch[1])
      : null;

    const rawPrice = priceMatch
      ? cleanText(priceMatch[1])
      : null;

    if (!title) continue;

    products.push({
      asin,
      title,
      price: parsePrice(rawPrice),
      rawPrice,
      currency: "PLN",
      image: imageMatch?.[1] || null,
      url: `https://www.amazon.pl/dp/${asin}`,
    });

    if (products.length >= 20) break;
  }

  return products;
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    const query =
      searchParams.get("q") || "Warhammer";

    const books = await searchAmazon(query);

    return Response.json(
      {
        query,
        updatedAt: new Date().toISOString(),
        count: books.length,
        books,
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
      { status: 500 }
    );
  }
}
