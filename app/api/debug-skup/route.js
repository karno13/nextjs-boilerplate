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

export async function GET() {
  const urls = [
    "https://skupszop.pl/wydawnictwo/black-library",
    "https://skupszop.pl/wydawnictwo/black-library?p=2",
    "https://skupszop.pl/wydawnictwo/copernicus-center-press",
    "https://skupszop.pl/wydawnictwo/copernicus-center-press?p=2",
  ];

  const results = [];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: HEADERS,
      });

      const html = await response.text();
      const lower = html.toLowerCase();

      const probes = [
        "horus",
        "warhammer",
        "black library",
        "copernicus",
        "nowa",
        "używana",
        "zł",
      ];

      const snippets = {};

      for (const probe of probes) {
        const index = lower.indexOf(probe);

        snippets[probe] =
          index >= 0
            ? html.slice(
                Math.max(0, index - 1000),
                Math.min(html.length, index + 2500)
              )
            : null;
      }

      results.push({
        url,
        status: response.status,
        htmlLength: html.length,
        snippets,
      });
    } catch (error) {
      results.push({
        url,
        error: error.message,
      });
    }
  }

  return Response.json({
    results,
  });
}
