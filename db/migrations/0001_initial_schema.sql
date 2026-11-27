-- profiles: for storing user specific job information
create table profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  full_name    text,
  city         text,
  country      text,
  wanted_roles text[] not null default '{}'
);

-- resumes: for storing resume file path and AI-parsed text
create table resumes (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references profiles (id) on delete cascade,
  file_path      text not null,
  file_hash      text not null,
  gemini_profile jsonb,
  uploaded_at    timestamptz not null default now(),
  unique (user_id, file_hash)
);
create index resumes_user_latest_idx on resumes (user_id, uploaded_at desc);

-- companies: for storing companies to scan
create table companies (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  job_board        text not null check (job_board in ('greenhouse', 'lever', 'ashby')),
  company_board_id text not null,
  unique (job_board, company_board_id)
);

-- jobs: for storing raw job data collected from APIs
create table jobs (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies (id) on delete cascade,
  board_job_id   text not null,
  duplicate_key  text not null unique,
  title          text not null,
  standard_title text,
  city           text,
  country        text,
  apply_url      text,
  raw_data       jsonb,
  last_updated   timestamptz not null default now(),
  unique (company_id, board_job_id)
);
create index jobs_standard_title_idx on jobs (standard_title);
create index jobs_last_updated_idx on jobs (last_updated);

-- job_matches: for storing how well jobs match a user
create table job_matches (
  user_id        uuid not null references profiles (id) on delete cascade,
  job_id         uuid not null references jobs (id) on delete cascade,
  match_score    smallint not null check (match_score between 0 and 100),
  gemini_reasons text[] not null default '{}',
  primary key (user_id, job_id)
);
create index job_matches_job_idx on job_matches (job_id);

-- title_synonyms: for mapping titles to standard ones to reduce search/analysis costs
create table title_synonyms (
  raw_title      text primary key,
  standard_title text not null
);
create index title_synonyms_standard_idx on title_synonyms (standard_title);

-- Row level security: users only see data they are authorised to
alter table profiles       enable row level security;
alter table resumes        enable row level security;
alter table companies      enable row level security;
alter table jobs           enable row level security;
alter table job_matches    enable row level security;
alter table title_synonyms enable row level security; -- backend only: no browser access

create policy "own profile: read"   on profiles    for select to authenticated using ((select auth.uid()) = id);
create policy "own profile: insert" on profiles    for insert to authenticated with check ((select auth.uid()) = id);
create policy "own profile: update" on profiles    for update to authenticated using ((select auth.uid()) = id);
create policy "own resumes: read"   on resumes     for select to authenticated using ((select auth.uid()) = user_id);
create policy "own matches: read"   on job_matches for select to authenticated using ((select auth.uid()) = user_id);
create policy "companies: read"     on companies   for select to authenticated using (true);
create policy "jobs: read"          on jobs        for select to authenticated using (true);

-- Realtime: push new matches to the feed
alter publication supabase_realtime add table job_matches;