# Odczyt sklepów dla Archiwum 40K

Endpoint `POST /api/source-page` uruchamia pobieranie HTML w Node.js na Vercel. Archiwum może następnie używać własnych parserów cen i dopasowania książek. Istniejący `GET /api/books` pozostaje kompatybilny.

## Konfiguracja

Ustaw sekret `ARCHIWUM_FETCH_TOKEN` (co najmniej 32 losowe znaki) w projekcie Vercel. Użyj tego samego sekretu wyłącznie po stronie serwera Archiwum. Nie umieszczaj go w `NEXT_PUBLIC_*`, kodzie klienta, repozytorium ani adresie URL.

Po wdrożeniu wywołuj endpoint z serwera:

```js
const response = await fetch('https://nextjs-boilerplate-lb8m.vercel.app/api/source-page', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    source: 'graal',
    url: 'https://sklep-graal.pl/pl/p/Legends-of-the-Waaagh-Paperback/22215',
  }),
  signal,
});
if (!response.ok) throw new Error('Vercel / źródło: HTTP ' + response.status);
const html = await response.text();
```

Dozwolone klucze źródeł: `adumaru`, `battlecult`, `graal`, `kulturawraca`, `megaksiazki`, `mepel`, `osnowa`, `zagrajnik`. Dostępne są tylko publiczne adresy produktów, wyszukiwania i działów tych sklepów. Przekierowania na obce domeny lub HTTP są odrzucane.

Odczyt ma limit 15 sekund, 4 MB odpowiedzi i 3 jednoczesnych żądań w jednym procesie. Błędy HTTP źródła są przekazywane jako błędy; nie są interpretowane jako brak ofert. HTML jest zwracany jako dane do parsera, nie powinien być renderowany w interfejsie.

## Weryfikacja

Uruchom `node tests/source-page.mjs`, `npx eslint app/api/source-page/route.js lib/source-page.mjs tests/source-page.mjs`, `npx tsc --noEmit` oraz build na Vercel.

Po wdrożeniu sprawdź konkretny produkt, jego aktualną cenę i dostępność oraz zapis w Archiwum. Sam HTTP 200 nie potwierdza poprawnego parsera. Wyniki testu starego endpointu Vercel z 2026-10-08: Graal, Osnowa, Zagrajnik i Megaksiążki zwróciły 200; Mepel zwrócił 403. Adumaru, Battlecult i Kultura Wraca wymagają testu nowego endpointu z Vercel. Nie ma jeszcze potwierdzenia działania tego nowego endpointu na produkcji.
