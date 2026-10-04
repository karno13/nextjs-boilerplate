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

async function fetchWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: HEADERS,
      signal: controller.signal,
    });

    const html = await response.text();

    return {
      status: response.status,
      html,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET() {
  const urls = [
    "https://panmysza.pl",
  ];

  const results = [];

  for (const url of urls) {
    try {
      const { status, html } =
        await fetchWithTimeout(url);

      const lower =
        html.toLowerCase();

      const probes = [
        "warhammer",
        "black library",
        "horus",
        "product",
        "price",
        "zł",
      ];

      const snippets = {};

      for (const probe of probes) {
        const index =
          lower.indexOf(probe);

        snippets[probe] =
          index >= 0
            ? html.slice(
                Math.max(0, index - 1200),
                Math.min(
                  html.length,
                  index + 3000
                )
              )
            : null;
      }

      results.push({
        url,
        status,
        htmlLength:
          html.length,
        snippets,
      });

    } catch (error) {
      results.push({
        url,
        error:
          error.name === "AbortError"
            ? "TIMEOUT"
            : error.message,
      });
    }
  }

  return Response.json({
    results,
  });
}
