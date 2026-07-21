-- Optional DBA migration. The application role intentionally cannot alter journal.
-- Run this file as the owner of public.journal when the raw tail grows large.
create index concurrently if not exists journal_posted_date_idx
  on public.journal (posting_date) where status = 'Posted';

create index concurrently if not exists journal_posted_normalized_account_date_idx
  on public.journal (
    (regexp_replace(coalesce(account_code, root_account_code, ''), '^0+', '')),
    posting_date,
    journal_id
  ) where status = 'Posted';
