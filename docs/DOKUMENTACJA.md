# LiteMongo — dokumentacja użytkownika

LiteMongo to lekki, webowy klient MongoDB (alternatywa dla Compass / Studio 3T). Jeden proces Node.js serwuje API (`/api`), serwer MCP (`/mcp`) oraz skompilowany frontend React (PWA) na jednym porcie.

**Ważne:** serwer jest bezstanowy. Connection stringi i hasła żyją wyłącznie w przeglądarce (localStorage) i są wysyłane z każdym żądaniem w nagłówku `X-Mongo-URI`. Serwer nic nie zapisuje na dysku.

## Spis treści

1. [Wymagania](#1-wymagania)
2. [Szybki start (lokalnie, tryb deweloperski)](#2-szybki-start-lokalnie-tryb-deweloperski)
3. [Lokalna baza MongoDB z danymi przykładowymi](#3-lokalna-baza-mongodb-z-danymi-przykładowymi)
4. [Uruchomienie produkcyjne bez Dockera](#4-uruchomienie-produkcyjne-bez-dockera)
5. [Docker: budowanie i uruchamianie obrazu](#5-docker-budowanie-i-uruchamianie-obrazu)
6. [Deployment na jump-hoście (AWS EC2)](#6-deployment-na-jump-hoście-aws-ec2)
7. [Zmienne środowiskowe](#7-zmienne-środowiskowe)
8. [Pierwsze kroki w UI](#8-pierwsze-kroki-w-ui)
9. [Konfiguracja przenośna `litemongo.config.json`](#9-konfiguracja-przenośna-litemongoconfigjson)
10. [Serwer MCP (`/mcp`)](#10-serwer-mcp-mcp)
11. [Instalacja jako aplikacja (PWA)](#11-instalacja-jako-aplikacja-pwa)
12. [Testy i kontrola typów](#12-testy-i-kontrola-typów)
13. [Rozwiązywanie problemów](#13-rozwiązywanie-problemów)

---

## 1. Wymagania

| Scenariusz | Potrzebne |
|---|---|
| Tryb deweloperski / build ręczny | Node.js **22+**, npm |
| Docker | Docker 24+ (z Buildx dla obrazów multi-arch) |
| Lokalna baza testowa | Docker + Docker Compose |
| Praca z danymi | Dostęp do MongoDB (v8/v9) — lokalnego lub zdalnego |

Sprawdź wersje:

```bash
node -v    # >= 22
npm -v
docker -v
```

## 2. Szybki start (lokalnie, tryb deweloperski)

Projekt to monorepo npm (workspaces `server` i `client`).

```bash
cd limemongo
npm install          # instaluje zależności obu workspace'ów
npm run dev          # startuje serwer (3001) i klienta Vite (5173) równolegle
```

Otwórz **http://localhost:5173**. Vite proxuje `/api` i `/mcp` do Fastify na porcie 3001, więc przeglądarka widzi jedno źródło — tak samo jak w produkcji.

Osobno:

```bash
npm run dev:server   # tylko backend (tsx watch, port 3001)
npm run dev:client   # tylko frontend (Vite, port 5173)
```

## 3. Lokalna baza MongoDB z danymi przykładowymi

`docker-compose.yml` uruchamia MongoDB 8 i ładuje dane przykładowe (domena ubezpieczeniowa):

- `mongo-seed.js` — `policies`, `claims`, `claim_items`
- `mongo-seed-rich.js` — `persons`, `contractors`, `policies2`, `claims2` (dynamiczne atrybuty)

```bash
docker compose up -d          # start bazy
docker compose ps             # sprawdź health
docker compose down           # zatrzymaj (dane zostają w wolumenie)
docker compose down -v        # zatrzymaj i USUŃ dane (re-seed przy następnym starcie)
```

Connection string do wpisania w LiteMongo:

```
mongodb://admin:localpassword@localhost:27017/insurance_dev?authSource=admin
```

> Skrypty seed uruchamiają się tylko przy **pierwszym** starcie z pustym wolumenem. Aby załadować je ponownie: `docker compose down -v && docker compose up -d`.

## 4. Uruchomienie produkcyjne bez Dockera

```bash
npm install
npm run build        # buduje klienta (client/dist) i kompiluje serwer (server/dist)
npm start            # serwer + statyczny frontend na http://localhost:3001
```

Zmiana portu / interfejsu:

```bash
PORT=8080 HOST=127.0.0.1 npm start
```

Tryb tylko do odczytu dla całej instancji:

```bash
FORCE_READ_ONLY=true npm start
```

## 5. Docker: budowanie i uruchamianie obrazu

`Dockerfile` jest wieloetapowy: etap 1 buduje klienta i serwer, etap 2 to minimalny `node:22-alpine` (bez natywnych dodatków, uruchamiany jako użytkownik `node`).

### Budowa dla bieżącej architektury

```bash
docker build -t litemongo:latest .
```

### Uruchomienie

```bash
docker run -d --name litemongo \
  -p 3001:3001 \
  --read-only \
  litemongo:latest
```

Otwórz **http://localhost:3001**. Health-check: `curl http://localhost:3001/api/health`.

Wymuszenie trybu tylko do odczytu (zalecane na jump-hoście):

```bash
docker run -d --name litemongo -p 3001:3001 --read-only \
  -e FORCE_READ_ONLY=true \
  litemongo:latest
```

Połączenie z bazą na hoście (Docker Desktop): w connection stringu użyj `host.docker.internal` zamiast `localhost`.

### Obraz multi-arch (amd64 + arm64 / AWS Graviton)

Jednorazowo utwórz builder:

```bash
docker buildx create --name litemongo-builder --use
```

Budowa i wypchnięcie do rejestru:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t <rejestr>/litemongo:latest --push .
```

Budowa lokalna bez push (jedna platforma, ładowana do lokalnego Dockera):

```bash
docker buildx build --platform linux/arm64 -t litemongo:arm64 --load .
```

Etap budowania działa natywnie na maszynie budującej (bez emulacji QEMU), tylko mały etap runtime jest per architektura.

### Eksport obrazu bez rejestru

```bash
docker save litemongo:latest | gzip > litemongo.tar.gz
# na serwerze docelowym:
gunzip -c litemongo.tar.gz | docker load
```

## 6. Deployment na jump-hoście (AWS EC2)

Zalecany model bezpieczeństwa:

1. **Użytkownik MongoDB z rolą `read`** — twarda ochrona na poziomie bazy.
2. **`FORCE_READ_ONLY=true`** na kontenerze — serwer blokuje wszystkie operacje mutujące (`/api/transfer/paste` oraz zapisy w trybie skryptowym `/api/shell/op`) i zwraca `403 READ_ONLY`.
3. **Nie wystawiaj portu publicznie.** Wiąż na loopback i wchodź tunelem SSH:

```bash
# na jump-hoście
docker run -d --name litemongo --restart unless-stopped --read-only \
  -p 127.0.0.1:3001:3001 \
  -e FORCE_READ_ONLY=true \
  <rejestr>/litemongo:latest

# na Twoim komputerze
ssh -L 3001:127.0.0.1:3001 ec2-user@<jump-host>
# następnie otwórz http://localhost:3001
```

4. Opcjonalnie podmontuj własny plik konfiguracji, aby zasilić `/mcp`:

```bash
docker run -d --name litemongo -p 127.0.0.1:3001:3001 --read-only \
  -e FORCE_READ_ONLY=true \
  -e LITEMONGO_CONFIG=/config/litemongo.config.json \
  -v $PWD/litemongo.config.json:/config/litemongo.config.json:ro \
  <rejestr>/litemongo:latest
```

> Aplikacja nie ma własnego uwierzytelniania. Dostęp kontroluj siecią (tunel SSH, security groups, VPN). Nie wystawiaj jej bezpośrednio do internetu.

## 7. Zmienne środowiskowe

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `PORT` | `3001` | Port nasłuchu |
| `HOST` | `0.0.0.0` | Interfejs nasłuchu (`127.0.0.1` = tylko lokalnie) |
| `FORCE_READ_ONLY` | `false` | `true` blokuje wszystkie operacje zapisu, niezależnie od ustawień w UI |
| `LOG_LEVEL` | `info` | Poziom logów Fastify |
| `LITEMONGO_CONFIG` | — | Ścieżka do `litemongo.config.json` dla serwera MCP |
| `CLIENT_DIST` | `client/dist` | Alternatywna ścieżka do zbudowanego frontendu |
| `MONGO_CLIENT_IDLE_TTL_MS` | `300000` | Po jakim czasie bezczynności zamykany jest pool połączeń (5 min) |
| `MONGO_MAX_CLIENTS` | `32` | Maks. liczba jednocześnie cache'owanych klientów MongoDB |

Nagłówki `X-Mongo-URI` nigdy nie są logowane.

## 8. Pierwsze kroki w UI

1. **Dodaj połączenie** — nazwa, URI, środowisko (tier) i flaga read-only. Profile zapisywane są tylko w przeglądarce.
2. **Środowiska:**
   - **PROD / CLIENT** (czerwone) — zawsze tylko do odczytu, blokada nie do zdjęcia,
   - **TEST** (pomarańczowe),
   - **DEV / LOCAL** (zielone).
3. **Karty (taby)** — niezależne zapytania do różnych kolekcji/baz/połączeń naraz.
4. **Edytor zapytań** — tryb wizualny zsynchronizowany z edytorem Monaco (JSON/MQL), podpowiedzi z zadeklarowanych schematów.
5. **Widoki danych:** drzewo (Tree), tabela płaska (Flat), tabela zagnieżdżona (Table-in-Table) z plakietkami `code`.
6. **Relacje (Relation Blueprints)** — np. `policies._id → claims.policyId → claim_items.claimId`; pobierane dwoma–trzema zapytaniami `$in` zamiast `$lookup`.
7. **Kopiuj / wklej między środowiskami** — dane jako Extended JSON (zachowane typy BSON). Opcja **Renumber / Remap IDs** przenumerowuje ID z zachowaniem powiązań i kodów domenowych; przed wstawieniem dostępny jest podgląd (dry-run).
8. **Inspektory:** unikalne wartości pola (klik w nagłówek kolumny), lista indeksów kolekcji.
9. **Tryb skryptowy (free-query)** — skrypty w stylu mongosh uruchamiane w Web Workerze w przeglądarce; serwer wykonuje wyłącznie pojedyncze operacje (`/api/shell/op`) i nigdy nie wykonuje kodu użytkownika.

## 9. Konfiguracja przenośna `litemongo.config.json`

Jeden plik JSON zawiera: schematy kolekcji (`idPaths`, słowniki `{ code, value }`), relacje, reguły wyświetlania plakietek `code`, zapisane zapytania i reguły przenumerowania ID.

- Przykład: `litemongo.config.example.json`
- Eksport/import oraz synchronizacja (schowek lub plik) z poziomu UI (Import/Export).
- Typowy przepływ: skonfiguruj na jump-hoście → skopiuj config → wklej lokalnie.

## 10. Serwer MCP (`/mcp`)

Wbudowany, **tylko do odczytu** serwer Model Context Protocol dla asystentów AI. Udostępnia narzędzia:

- `list_schemas` — udokumentowane schematy i słowniki kodów,
- `list_relations` — zapisane relacje master-detail,
- `query_master_detail` — bezpieczne zapytanie po relacji, zwraca sklejoną hierarchię 2–3 poziomów.

Endpoint: `http://localhost:3001/mcp`. Aby serwer znał schematy i relacje, uruchom go z `LITEMONGO_CONFIG` wskazującym plik konfiguracji (patrz sekcja 6).

## 11. Instalacja jako aplikacja (PWA)

LiteMongo jest Progressive Web App. W Chrome/Edge (po wejściu na działającą instancję) kliknij ikonę „Zainstaluj” w pasku adresu → aplikacja otwiera się we własnym oknie, z cache'em zasobów (w tym Monaco) działającym offline.

Uwaga: PWA nadal **wymaga działającego serwera** (kontener lub `npm start`), bo to on łączy się z MongoDB. Przeglądarka nie potrafi mówić protokołem MongoDB.

## 12. Testy i kontrola typów

```bash
npm run typecheck    # tsc dla serwera i klienta
npm test             # testy serwera (node:test)
```

> Testy integracyjne mogą wymagać działającej bazy MongoDB (zob. sekcja 3).

## 13. Rozwiązywanie problemów

| Objaw | Przyczyna / rozwiązanie |
|---|---|
| `Unsupported engine` przy `npm install` | Zainstaluj Node.js ≥ 22 |
| UI nie ładuje się na porcie 3001 | Nie zbudowano klienta — uruchom `npm run build` (serwer serwuje frontend tylko gdy istnieje `client/dist/index.html`) |
| Kontener nie łączy się z lokalną bazą | Użyj `host.docker.internal` zamiast `localhost` w URI |
| Błąd uwierzytelniania na lokalnej bazie | Dodaj `?authSource=admin` do URI |
| Zapis zablokowany (403) | Połączenie jest oznaczone read-only, tier PROD/CLIENT albo ustawiono `FORCE_READ_ONLY=true` |
| Stara wersja UI po wdrożeniu | Service worker aktualizuje się przy kolejnym wczytaniu — odśwież dwa razy |
| Zdrowie serwera | `curl http://localhost:3001/api/health` |
