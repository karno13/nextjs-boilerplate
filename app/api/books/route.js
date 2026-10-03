export async function GET() {
  const books = [
    {
      title: "Horus Rising",
      author: "Dan Abnett",
      asin: "184416294X",
      price: 12.99,
      currency: "EUR",
      condition: "New",
      url: "https://www.amazon.de/"
    },
    {
      title: "False Gods",
      author: "Graham McNeill",
      asin: "1844163709",
      price: 15.49,
      currency: "EUR",
      condition: "Used - Very Good",
      url: "https://www.amazon.de/"
    }
  ];

  return Response.json(
    {
      updatedAt: new Date().toISOString(),
      books
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*"
      }
    }
  );
}
