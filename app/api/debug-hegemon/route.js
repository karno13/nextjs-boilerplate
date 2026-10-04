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

async function inspect(url) {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: HEADERS,
      redirect: "follow",
    });

    const html =
      await response.text();

    const lower =
      html.toLowerCase();

    const probes = [
      "na stanie",
      "dostęp",
      "niedostęp",
      "brak",
      "dodaj do koszyka",
      "quantity",
      "stock",
      "availability",
      "add-to-cart",
      "product-quantity",
    ];

    const snippets = {};

    for (const probe of probes) {
      const index =
        lower.indexOf(
          probe.toLowerCase()
        );

      snippets[probe] =
        index >= 0
          ? html.slice(
              Math.max(
                0,
                index - 1500
              ),
              Math.min(
                html.length,
                index + 3000
              )
            )
          : null;
    }

    return {
      url,
      status:
        response.status,
      htmlLength:
        html.length,
      snippets,
    };

  } catch (error) {
    return {
      url,
      error:
        error.message,
    };
  }
}

export async function GET() {
  /*
    Pierwsza książka:
    wiemy, że Horus Rising miał stock = 3.

    Druga:
    Mechanicum ma obecnie stock = null.

    Dzięki porównaniu zobaczymy,
    jak Hegemon koduje oba przypadki.
  */

  const urls = [
    "https://hegemonshop.com/pl/black-library/16578-horus-rising-eng-9781836093145.html",

    "https://hegemonshop.com/pl/black-library/1607-horus-heresy-mechanicum-pb.html",

    "https://hegemonshop.com/pl/black-library/1603-horus-heresy-battle-for-the-abyss-pb-9781849708074.html",
  ];

  const results = [];

  for (const url of urls) {
    results.push(
      await inspect(url)
    );
  }

  return Response.json({
    results,
  });
}
