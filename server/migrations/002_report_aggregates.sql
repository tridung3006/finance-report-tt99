create table if not exists public.monthly_profit_loss_aggregates (
  id bigint generated always as identity primary key,
  batch_id text not null,
  month_end date not null,
  account_code text not null,
  account_name text not null default '',
  root_account_code text not null default '',
  root_account_name text not null default '',
  debit numeric(24, 2) not null default 0,
  credit numeric(24, 2) not null default 0,
  source_row_count bigint not null default 0,
  created_at timestamptz not null,
  unique (batch_id, month_end, account_code, root_account_code)
);

create index if not exists monthly_profit_loss_month_batch_idx
  on public.monthly_profit_loss_aggregates (month_end, batch_id);

create index if not exists account_balance_snapshots_latest_batch_idx
  on public.account_balance_snapshots (snapshot_date, created_at desc, batch_id desc);

create index if not exists account_balance_snapshots_read_idx
  on public.account_balance_snapshots (snapshot_date, batch_id, account_code, root_account_code, account_analytic);

create table if not exists public.monthly_cash_flow_movements (
  id bigint generated always as identity primary key,
  batch_id text not null,
  month_end date not null,
  source_id bigint,
  journal_id bigint,
  journal_num text,
  source_num text,
  journal_name text,
  posting_date date not null,
  account_code text,
  account_name text,
  root_account_code text,
  amount numeric(24, 2) not null,
  opposite_accounts text[] not null default '{}',
  opposite_rows jsonb not null default '[]'::jsonb,
  cash_line_count integer not null default 0,
  created_at timestamptz not null,
  unique (batch_id, month_end, journal_id, source_id)
);

create index if not exists monthly_cash_flow_month_batch_idx
  on public.monthly_cash_flow_movements (month_end, batch_id, posting_date);

create table if not exists public.payable_open_item_snapshots (
  id bigint generated always as identity primary key,
  batch_id text not null,
  snapshot_date date not null,
  source_id bigint not null,
  journal_id bigint,
  journal_num text,
  source_num text,
  journal_name text,
  posting_date date not null,
  account_code text,
  account_name text,
  root_account_code text,
  root_account_name text,
  account_analytic text not null default '',
  account_analytic_key text not null,
  department text,
  original_credit numeric(24, 2) not null,
  remaining_credit numeric(24, 2) not null,
  source_row_count bigint not null default 0,
  created_at timestamptz not null,
  unique (batch_id, snapshot_date, source_id)
);

create index if not exists payable_open_items_snapshot_batch_idx
  on public.payable_open_item_snapshots (snapshot_date, batch_id, account_analytic_key, posting_date);

create or replace view public.current_monthly_profit_loss_aggregates as
select aggregate.*
  from public.monthly_profit_loss_aggregates aggregate
  join (
    select distinct snapshot_date, batch_id
      from public.account_balance_snapshots
  ) current_batch
    on current_batch.snapshot_date = aggregate.month_end
   and current_batch.batch_id = aggregate.batch_id;

create or replace view public.current_monthly_cash_flow_movements as
select movement.*
  from public.monthly_cash_flow_movements movement
  join (
    select distinct snapshot_date, batch_id
      from public.account_balance_snapshots
  ) current_batch
    on current_batch.snapshot_date = movement.month_end
   and current_batch.batch_id = movement.batch_id;

create or replace view public.current_payable_open_item_snapshots as
select item.*
  from public.payable_open_item_snapshots item
  join (
    select distinct snapshot_date, batch_id
      from public.account_balance_snapshots
  ) current_batch
    on current_batch.snapshot_date = item.snapshot_date
   and current_batch.batch_id = item.batch_id;

revoke all on public.monthly_profit_loss_aggregates from public;
revoke all on public.monthly_cash_flow_movements from public;
revoke all on public.payable_open_item_snapshots from public;
