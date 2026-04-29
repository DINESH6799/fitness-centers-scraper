# Fitness Centers Scraper

A city-wide gym and fitness center scraper built on Google Places API (New).

It is optimized for:
- broad retrieval of real gyms and fitness centers
- strict final cleaning for clean exports
- lightweight Google field masks to manage cost
- optional Supabase persistence for session status and results

## How it works

The scraper uses a hybrid retrieval strategy:
- type-based nearby search across a city grid
- broader fallback text search per city
- dense-cell refinement using smaller nearby searches
- keyword recall around dense cells for gyms that Google may otherwise crowd out

This was added specifically to reduce misses for real gyms such as Cult locations that may not surface reliably from type-only search.

## Files

- `fitness-server.js` - Express backend and scrape engine
- `fitness-centers.html` - frontend UI served by the backend
- `cities.js` - city bounds/config
- `supabase_fitness_schema.sql` - table schema for Supabase persistence
- `render.yaml` - Render deployment blueprint

## Local run

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3002
```

## Supabase setup

Run the SQL in:

- `supabase_fitness_schema.sql`

Then start the app with:

```bash
export SUPABASE_URL='https://your-project-id.supabase.co'
export SUPABASE_KEY='your-key'
npm run dev
```

Health check:

```text
http://localhost:3002/health
```

When Supabase is connected, session snapshots and final results are mirrored there.

## Deploy to Render

This repo includes `render.yaml`.

Required env vars on Render:
- `SUPABASE_URL`
- `SUPABASE_KEY`

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

Health path:

```text
/health
```

## Important behavior

- The final `Strict Gyms` export remains strict even if retrieval is broader.
- Multi-city scraping runs in one session.
- If the server restarts during an in-progress scrape, persisted sessions are marked failed and should be rerun.
