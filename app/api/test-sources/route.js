export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOURCES = [
  {
    name: "Hegemon",
    url: "https://hegemonshop.com/pl/314-black-library",
  },
  {
    name: "Pan Mysza",
    url: "https://panmysza.pl/pl/c/Black-Library/686",
  },
  {
    name: "Graal",
    url: "https://sklep-graal.pl/pl/c/Ksiazki-w-swiecie-Warhammera/606",
  },
  {
    name: "Osnowa",
    url: "https://osnowa.pl/",
  },
  {
    name: "MegaKsiazki",
    url: "https://www.megaksiazki.pl/3024-warhammer-40-000",
  },
  {
    name: "Zagrajnik",
    url: "https://zagrajnik.shop/",
  },
  {
    name: "Czytam.pl",
    url: "https://czytam.pl/seria/warhammer-40-000",
  },
  {
    name: "Tantis",
    url: "https://tantis.pl/",
  },
  {
    name: "TaniaKsiazka",
    url: "https://www.taniaksiazka.pl/",
  },
  {
    name: "SkupSzop",
    url: "https://skupszop.pl/",
  },
  {
    name: "ERLI",
    url: "https://erli.pl/",
  },
  {
    name: "Mepel",
    url: "https://mepel.pl/",
  },
  {
    name: "Warhammer",
    url: "https://www.warhammer.com/",
  },
];

async function testSource(source) {
  const startedAt = Date.now();

  try {
    const response = await fetch(source.url, {
      cache: "no-store",

      redirect: "follow",

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

    const html = await response.text();

    const lower = html.toLowerCase();

    return {
      name: source.name,
      url: source.url,

      ok: response.ok,
      status: response.status,

      finalUrl: response.url,

      responseTimeMs:
        Date.now() - startedAt,

      htmlLength:
        html.length,

      signals: {
        hasPrice:
          lower.includes("zł") ||
          lower.includes("cena"),

        hasBook:
          lower.includes("książ") ||
          lower.includes("book"),

        hasWarhammer:
          lower.includes("warhammer"),

        hasBlackLibrary:
          lower.includes("black library"),

        hasProduct:
          lower.includes("produkt") ||
          lower.includes("product"),

        blocked:
          response.status === 403 ||
          response.status === 429 ||
          lower.includes("captcha") ||
          lower.includes("access denied"),
      },

      preview:
        html
          .replace(/\s+/g, " ")
          .slice(0, 250),
    };
  } catch (error) {
    return {
      name: source.name,
      url: source.url,

      ok: false,
      status: null,

      responseTimeMs:
        Date.now() - startedAt,

      error:
        error.message,
    };
  }
}

export async function GET() {
  /*
    Testujemy po kolei, a nie równolegle.
    Mniej agresywne i łatwiejsze do diagnozy.
  */

  const results = [];

  for (const source of SOURCES) {
    const result =
      await testSource(source);

    results.push(result);

    // mała przerwa między domenami
    await new Promise(
      (resolve) =>
        setTimeout(resolve, 300)
    );
  }

  const usable =
    results.filter(
      (result) =>
        result.ok &&
        !result.signals?.blocked
    );

  const blocked =
    results.filter(
      (result) =>
        result.signals?.blocked
    );

  return new Response(
    JSON.stringify(
      {
        testedAt:
          new Date().toISOString(),

        tested:
          results.length,

        usable:
          usable.length,

        blocked:
          blocked.length,

        usableSources:
          usable.map(
            (item) => item.name
          ),

        blockedSources:
          blocked.map(
            (item) => item.name
          ),

        results,
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
          "no-store",
      },
    }
  );
}
