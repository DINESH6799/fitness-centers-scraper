create table if not exists public.fitness_scraping_sessions (
    session_id text primary key,
    city_names jsonb not null default '[]'::jsonb,
    mode_key text not null,
    mode_label text not null,
    status text not null,
    progress jsonb not null default '{}'::jsonb,
    total_operations integer not null default 0,
    completed_operations integer not null default 0,
    request_count integer not null default 0,
    total_results integer not null default 0,
    results jsonb not null default '[]'::jsonb,
    error_message text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists fitness_scraping_sessions_status_idx
    on public.fitness_scraping_sessions (status);

create index if not exists fitness_scraping_sessions_updated_at_idx
    on public.fitness_scraping_sessions (updated_at desc);
