export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchHtml(url) {
  const response =
    await fetch(url, {
      cache: "no-store",
      headers: HEADERS,
      redirect: "follow",
    });

  const html =
    await response.text();

  return {
    status:
      response.status,

    finalUrl:
      response.url,

    html,
  };
}

function inspectPage(html) {
  /*
    Wszystkie data-id-product.
  */

  const allIds = [
    ...html.matchAll(
      /data-id-product=["'](\d+)["']/gi
    ),
  ].map(
    (match) =>
      match[1]
  );

  /*
    ID tylko z article.product-miniature.
  */

  const articleIds = [
    ...html.matchAll(
      /<article\b[^>]*class=["'][^"']*product-miniature[^"']*["'][^>]*data-id-product=["'](\d+)["']/gi
    ),
  ].map(
    (match) =>
      match[1]
  );

  /*
    W drugiej kolejności:
    article może mieć atrybuty
    w odwrotnej kolejności.
  */

  const articleIdsReverse = [
    ...html.matchAll(
      /<article\b[^>]*data-id-product=["'](\d+)["'][^>]*class=["'][^"']*product-miniature[^"']*["'][^>]*>/gi
    ),
  ].map(
    (match) =>
      match[1]
  );

  const combinedArticleIds =
    [
      ...articleIds,
      ...articleIdsReverse,
    ];

  /*
    Tytuły product-title.
  */

  const titleMatches = [
    ...html.matchAll(
      /<h2[^>]*class=["'][^"']*product-title[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    ),
  ];

  const titles =
    titleMatches.map(
      (match) => ({
        url:
          match[1],

        title:
          cleanText(
            match[2]
          ),
      })
    );

  /*
    Linki produktowe /pl/...
    ograniczone do Hegemona.
  */

  const productLinks = [
    ...html.matchAll(
      /href=["'](https:\/\/hegemonshop\.com\/pl\/[^"']+\.html)["']/gi
    ),
  ].map(
    (match) =>
      match[1]
  );

  /*
    Deduplikacja.
  */

  const uniqueIds =
    [
      ...new Set(
        allIds
      ),
    ];

  const uniqueArticleIds =
    [
      ...new Set(
        combinedArticleIds
      ),
    ];

  const uniqueLinks =
    [
      ...new Set(
        productLinks
      ),
    ];

  /*
    Informacja "Pokazano X-Y z Z".
  */

  const text =
    cleanText(html);

  const shown =
    text.match(
      /Pokazano\s+(\d+)\s*-\s*(\d+)\s+z\s+(\d+)\s+pozycji/i
    );

  return {
    shown:
      shown
        ? {
            from:
              Number(
                shown[1]
              ),

            to:
              Number(
                shown[2]
              ),

            total:
              Number(
                shown[3]
              ),
          }
        : null,

    counts: {
      allDataProductIds:
        allIds.length,

      uniqueDataProductIds:
        uniqueIds.length,

      articleProductIds:
        combinedArticleIds.length,

      uniqueArticleProductIds:
        uniqueArticleIds.length,

      productTitles:
        titles.length,

      uniqueProductLinks:
        uniqueLinks.length,
    },

    firstIds:
      uniqueIds.slice(
        0,
        10
      ),

    lastIds:
      uniqueIds.slice(
        -10
      ),

    firstTitles:
      titles.slice(
        0,
        5
      ),

    lastTitles:
      titles.slice(
        -5
      ),
  };
}

export async function GET() {
  const base =
    "https://hegemonshop.com/pl/314-black-library";

  const pages = [];

  /*
    Pobieramy trochę więcej niż 11,
    żeby zobaczyć, czy istnieją
    realne strony 12, 13, 14...
  */

  for (
    let page = 1;
    page <= 16;
    page++
  ) {
    try {
      const url =
        `${base}?order=product.name.asc&page=${page}`;

      const result =
        await fetchHtml(
          url
        );

      const inspection =
        inspectPage(
          result.html
        );

      pages.push({
        page,

        requestedUrl:
          url,

        status:
          result.status,

        finalUrl:
          result.finalUrl,

        htmlLength:
          result.html.length,

        ...inspection,
      });

    } catch (error) {
      pages.push({
        page,
        error:
          error.message,
      });
    }
  }

  return Response.json({
    pages,
  });
}
