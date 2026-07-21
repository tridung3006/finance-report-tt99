begin;

-- A row exists only after every monthly artifact has been built and reconciled
-- in the same transaction. This makes zero-activity months distinguishable
-- from incomplete or legacy batches.
create table if not exists public.monthly_report_aggregate_controls (
  snapshot_date date primary key,
  batch_id text not null,
  balance_source_row_count bigint not null,
  balance_debit numeric(24, 2) not null,
  balance_credit numeric(24, 2) not null,
  profit_loss_source_row_count bigint not null,
  profit_loss_debit numeric(24, 2) not null,
  profit_loss_credit numeric(24, 2) not null,
  cash_movement_count bigint not null,
  cash_net_amount numeric(24, 2) not null,
  payable_open_item_count bigint not null,
  payable_open_amount numeric(24, 2) not null,
  created_at timestamptz not null
);

revoke all on public.monthly_report_aggregate_controls from public;

commit;
