begin;

-- A control row is committed only after the balance snapshot and all related
-- monthly aggregates have been built and reconciled in the same transaction.
-- Use it as the single source of truth for the active batch of each month.
create or replace view public.current_monthly_profit_loss_aggregates as
select aggregate.*
  from public.monthly_profit_loss_aggregates aggregate
  join public.monthly_report_aggregate_controls control
    on control.snapshot_date = aggregate.month_end
   and control.batch_id = aggregate.batch_id;

create or replace view public.current_monthly_cash_flow_movements as
select movement.*
  from public.monthly_cash_flow_movements movement
  join public.monthly_report_aggregate_controls control
    on control.snapshot_date = movement.month_end
   and control.batch_id = movement.batch_id;

create or replace view public.current_payable_open_item_snapshots as
select item.*
  from public.payable_open_item_snapshots item
  join public.monthly_report_aggregate_controls control
    on control.snapshot_date = item.snapshot_date
   and control.batch_id = item.batch_id;

drop view if exists public.current_account_balance_snapshots;
drop index if exists public.account_balance_snapshots_latest_batch_idx;

commit;
