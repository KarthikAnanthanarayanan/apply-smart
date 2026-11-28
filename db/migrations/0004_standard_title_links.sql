-- standard_titles: the ESCO occupations that synonyms and jobs link to by id.
create table standard_titles (
  id   uuid primary key default gen_random_uuid(),
  name text not null unique
);

insert into standard_titles (name)
select distinct standard_title from title_synonyms;

-- title_synonyms: one row per (title, standard title) pair, so a title can map to several occupations.
-- The single-column primary key (title_synonyms_pkey, declared inline in 0001) goes first, so normalising
-- titles below can't collide on it.
alter table title_synonyms drop constraint if exists title_synonyms_pkey;
alter table title_synonyms rename column raw_title to title;

delete from title_synonyms a
using title_synonyms b
where lower(trim(a.title)) = lower(trim(b.title))
  and a.standard_title = b.standard_title
  and a.ctid > b.ctid;
update title_synonyms set title = lower(trim(title)) where title <> lower(trim(title));

alter table title_synonyms add column standard_title_id uuid references standard_titles (id) on delete cascade;
update title_synonyms ts set standard_title_id = st.id from standard_titles st where st.name = ts.standard_title;
alter table title_synonyms alter column standard_title_id set not null;
alter table title_synonyms drop column standard_title; -- also drops title_synonyms_standard_idx
alter table title_synonyms add primary key (title, standard_title_id);
alter table title_synonyms add constraint title_synonyms_title_normalised check (title = lower(trim(title)));
create index title_synonyms_standard_title_id_idx on title_synonyms (standard_title_id);

-- job_standard_titles: the standard titles each job is linked to.
create table job_standard_titles (
  job_id            uuid not null references jobs (id) on delete cascade,
  standard_title_id uuid not null references standard_titles (id) on delete cascade,
  primary key (job_id, standard_title_id)
);
create index job_standard_titles_standard_title_id_idx on job_standard_titles (standard_title_id);

insert into job_standard_titles (job_id, standard_title_id)
select j.id, ts.standard_title_id
from jobs j
join title_synonyms ts on ts.title = lower(trim(j.title))
on conflict do nothing;

-- jobs: links live in job_standard_titles now; the index serves title_synonyms lookups by normalised title.
alter table jobs drop column standard_title; -- also drops jobs_standard_title_idx
create index jobs_normalised_title_idx on jobs (lower(trim(title)));

-- Backend only, like title_synonyms: RLS on with no policies, and no grant to authenticated.
alter table standard_titles     enable row level security;
alter table job_standard_titles enable row level security;

grant select, insert, update, delete
  on standard_titles, job_standard_titles
  to service_role;
