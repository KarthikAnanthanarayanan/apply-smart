-- Tables created via SQL aren't granted to the Data API roles automatically,
-- so without these every request fails with 42501 "permission denied".
-- RLS (0001) still decides which rows each role can see.

-- Backend (service role key): full access to every table.
grant select, insert, update, delete
  on profiles, resumes, companies, jobs, job_matches, title_synonyms
  to service_role;

-- Signed-in users: only what the RLS policies in 0001 allow.
grant select, insert, update on profiles    to authenticated;
grant select                 on resumes     to authenticated;
grant select                 on job_matches to authenticated;
grant select                 on companies   to authenticated;
grant select                 on jobs        to authenticated;
-- title_synonyms: backend only, no grant to authenticated.
