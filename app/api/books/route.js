export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const query = "Horus Rising";

    const url =
      "https://allegrolokalnie.pl/oferty/q/" +
      encodeURIComponent(query);

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

    const html = await response.text();

    return Response.json({
      ok: response.ok,
      status: response.status,
      query,
      url,

      htmlLength: html.length,

      containsHorus:
        html.toLowerCase().includes("horus"),

      preview:
        html.slice(0, 1000),
    });

  } catch (error) {
    return Response.json(
      {
        error: error.message,
      },
      {
        status: 500,
      }
    );
  }
}
