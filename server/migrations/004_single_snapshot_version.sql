begin;

-- Retain only the latest committed batch for each snapshot month before
-- enforcing the single-version invariant. Report artifacts follow the batch
-- selected by the balance snapshot.
create temporary table latest_snapshot_batches on commit drop as
select distinct on (snapshot_date) snapshot_date, batch_id
  from public.account_balance_snapshots
 order by snapshot_date, created_at desc, batch_id desc;

delete from public.monthly_profit_loss_aggregates aggregate
 where not exists (
   select 1 from latest_snapshot_batches keep
    where keep.snapshot_date = aggregate.month_end
      and keep.batch_id = aggregate.batch_id
 );

delete from public.monthly_cash_flow_movements movement
 where not exists (
   select 1 from latest_snapshot_batches keep
    where keep.snapshot_date = movement.month_end
      and keep.batch_id = movement.batch_id
 );

delete from public.payable_open_item_snapshots item
 where not exists (
   select 1 from latest_snapshot_batches keep
    where keep.snapshot_date = item.snapshot_date
      and keep.batch_id = item.batch_id
 );

delete from public.account_balance_snapshots snapshot
 where not exists (
   select 1 from latest_snapshot_batches keep
    where keep.snapshot_date = snapshot.snapshot_date
      and keep.batch_id = snapshot.batch_id
 );

alter table public.account_balance_snapshots
  drop constraint if exists account_balance_snapshots_batch_key;
alter table public.account_balance_snapshots
  add constraint account_balance_snapshots_month_account_key
  unique (snapshot_date, account_code, root_account_code, account_analytic);

alter table public.monthly_profit_loss_aggregates
  drop constraint if exists monthly_profit_loss_aggregate_batch_id_month_end_account_co_key;
alter table public.monthly_profit_loss_aggregates
  add constraint monthly_profit_loss_month_account_key
  unique (month_end, account_code, root_account_code);

alter table public.monthly_cash_flow_movements
  drop constraint if exists monthly_cash_flow_movements_batch_id_month_end_journal_id_s_key;
alter table public.monthly_cash_flow_movements
  add constraint monthly_cash_flow_month_journal_source_key
  unique (month_end, journal_id, source_id);

alter table public.payable_open_item_snapshots
  drop constraint if exists payable_open_item_snapshots_batch_id_snapshot_date_source_i_key;
alter table public.payable_open_item_snapshots
  add constraint payable_open_item_month_source_key
  unique (snapshot_date, source_id);

commit;
