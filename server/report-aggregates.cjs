const BALANCE_TABLE = "public.account_balance_snapshots";
const CONTROL_TABLE = "public.monthly_report_aggregate_controls";
const PROFIT_TABLE = "public.monthly_profit_loss_aggregates";
const PROFIT_VIEW = "public.current_monthly_profit_loss_aggregates";
const CASH_TABLE = "public.monthly_cash_flow_movements";
const CASH_VIEW = "public.current_monthly_cash_flow_movements";
const PAYABLE_TABLE = "public.payable_open_item_snapshots";
const PAYABLE_VIEW = "public.current_payable_open_item_snapshots";
const VIRTUAL_ACCOUNTS = "('More Account 111/112', 'More Account 131')";

function monthStart(dateText) {
  return `${String(dateText).slice(0, 7)}-01`;
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monthEnd(dateText) {
  const date = new Date(`${monthStart(dateText)}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

function addMonths(dateText, offset) {
  const date = new Date(`${monthStart(dateText)}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 10);
}

function fullMonthRange(startDate, endDate) {
  let first = monthStart(startDate);
  if (startDate !== first) first = addMonths(first, 1);
  let last = monthEnd(endDate);
  if (endDate !== last) last = monthEnd(addMonths(endDate, -1));
  if (first > last) return null;
  return { first, last };
}

async function assertReportAggregateSchema(client) {
  const result = await client.query(
    `select to_regclass($1) as balance_table,
            to_regclass($2) as control_table,
            to_regclass($3) as profit_table,
            to_regclass($4) as cash_table,
            to_regclass($5) as payable_table`,
    [BALANCE_TABLE, CONTROL_TABLE, PROFIT_TABLE, CASH_TABLE, PAYABLE_TABLE],
  );
  const row = result.rows[0] || {};
  if (!row.balance_table || !row.control_table || !row.profit_table || !row.cash_table || !row.payable_table) {
    const error = new Error("Report aggregate tables are missing; run server migrations through 006");
    error.status = 500;
    throw error;
  }
}

async function insertMonthlyReportAggregates(client, { batchId, startDate, endDate, createdAt }) {
  await assertReportAggregateSchema(client);
  await client.query(
    `insert into ${PROFIT_TABLE} (
       batch_id, month_end, account_code, account_name, root_account_code, root_account_name,
       debit, credit, source_row_count, created_at
     )
     select $1, $3::date,
            regexp_replace(coalesce(j.account_code, j.root_account_code, 'NO_ACCOUNT'), '^0+', ''),
            max(coalesce(j.account_name, '')),
            regexp_replace(coalesce(j.root_account_code, j.account_code, 'NO_ROOT'), '^0+', ''),
            max(coalesce(j.root_account_name, '')),
            sum(coalesce(j.debit, 0))::numeric(24, 2),
            sum(coalesce(j.credit, 0))::numeric(24, 2),
            count(*)::bigint,
            $4::timestamptz
       from public.journal j
      where j.status = 'Posted'
        and coalesce(j.account_name, '') not in ${VIRTUAL_ACCOUNTS}
        and j.posting_date between $2::date and $3::date
        and regexp_replace(coalesce(j.account_code, j.root_account_code, ''), '^0+', '') ~ '^[5-9]'
        and not exists (
          select 1 from public.journal closing_line
           where closing_line.journal_id = j.journal_id
             and closing_line.status = 'Posted'
             and regexp_replace(coalesce(closing_line.account_code, closing_line.root_account_code, ''), '^0+', '') ~ '^911'
        )
      group by regexp_replace(coalesce(j.account_code, j.root_account_code, 'NO_ACCOUNT'), '^0+', ''),
               regexp_replace(coalesce(j.root_account_code, j.account_code, 'NO_ROOT'), '^0+', '')`,
    [batchId, startDate, endDate, createdAt],
  );

  await client.query(
    `with cash_lines as (
       select j.id, j.journal_id, j.journal_num, j.source_num, j.journal_name, j.posting_date,
              j.account_code, j.account_name, j.root_account_code,
              coalesce(j.debit, 0) - coalesce(j.credit, 0) as amount
         from public.journal j
        where j.status = 'Posted'
          and coalesce(j.account_name, '') not in ${VIRTUAL_ACCOUNTS}
          and j.posting_date between $2::date and $3::date
          and regexp_replace(coalesce(j.account_code, j.root_account_code, ''), '^0+', '') ~ '^(111|112|113)'
     ), cash_group as (
       select min(id) as source_id, journal_id, max(journal_num) as journal_num,
              max(source_num) as source_num, max(journal_name) as journal_name,
              min(posting_date) as posting_date, min(account_code) as account_code,
              max(account_name) as account_name, min(root_account_code) as root_account_code,
              sum(amount)::numeric(24, 2) as amount, count(*)::int as cash_line_count
         from cash_lines group by journal_id
     ), opposite_group as (
       select cash.journal_id,
              coalesce(array_remove(array_agg(distinct regexp_replace(coalesce(o.account_code, o.root_account_code, ''), '^0+', '')), ''), '{}') as opposite_accounts,
              coalesce(jsonb_agg(distinct jsonb_build_object(
                'account', regexp_replace(coalesce(o.account_code, o.root_account_code, ''), '^0+', ''),
                'account_name', coalesce(o.account_name, ''),
                'account_analytic', coalesce(o.account_analytic, ''),
                'debit', coalesce(o.debit, 0), 'credit', coalesce(o.credit, 0)
              )) filter (where o.id is not null), '[]'::jsonb) as opposite_rows
         from (select distinct journal_id from cash_lines) cash
         left join public.journal o
           on o.journal_id = cash.journal_id and o.status = 'Posted'
          and coalesce(o.account_name, '') not in ${VIRTUAL_ACCOUNTS}
          and regexp_replace(coalesce(o.account_code, o.root_account_code, ''), '^0+', '') !~ '^(111|112|113)'
        group by cash.journal_id
     ), movement as (
       select cash.*, opposite.opposite_accounts, opposite.opposite_rows
         from cash_group cash join opposite_group opposite using (journal_id)
     )
     insert into ${CASH_TABLE} (
       batch_id, month_end, source_id, journal_id, journal_num, source_num, journal_name,
       posting_date, account_code, account_name, root_account_code, amount,
       opposite_accounts, opposite_rows, cash_line_count, created_at
     )
     select $1, $3::date, source_id, journal_id, journal_num, source_num, journal_name,
            posting_date, account_code, account_name, root_account_code, amount,
            opposite_accounts, opposite_rows, cash_line_count, $4::timestamptz
       from movement`,
    [batchId, startDate, endDate, createdAt],
  );

  await client.query(
    `with payable_rows as (
       select j.*,
              coalesce(trim(j.account_analytic), '') as analytic,
              sum(coalesce(j.credit, 0) - coalesce(j.debit, 0)) over (
                partition by coalesce(trim(j.account_analytic), '') order by j.posting_date, j.id
              ) as running_net,
              sum(coalesce(j.credit, 0)) over (
                partition by coalesce(trim(j.account_analytic), '') order by j.posting_date, j.id
                rows between unbounded preceding and 1 preceding
              ) as prior_credits
         from public.journal j
        where j.status = 'Posted'
          and coalesce(j.account_name, '') not in ${VIRTUAL_ACCOUNTS}
          and j.posting_date <= $2::date
          and regexp_replace(coalesce(j.root_account_code, j.account_code, ''), '^0+', '') = '331'
     ), analytic_totals as (
       select analytic,
              sum(coalesce(credit, 0)) as total_credits,
              sum(coalesce(credit, 0) - coalesce(debit, 0))
                - least(0, min(running_net)) as final_open
         from payable_rows group by analytic
     ), lots as (
       select row.*, totals.total_credits - totals.final_open as effective_payments,
              greatest(
                coalesce(row.credit, 0) - greatest((totals.total_credits - totals.final_open) - coalesce(row.prior_credits, 0), 0),
                0
              )::numeric(24, 2) as remaining_credit
         from payable_rows row join analytic_totals totals using (analytic)
        where coalesce(row.credit, 0) > 0
     )
     insert into ${PAYABLE_TABLE} (
       batch_id, snapshot_date, source_id, journal_id, journal_num, source_num, journal_name,
       posting_date, account_code, account_name, root_account_code, root_account_name,
       account_analytic, account_analytic_key, department, original_credit, remaining_credit,
       source_row_count, created_at
     )
     select $1, $2::date, id, journal_id, journal_num, source_num, journal_name, posting_date,
            account_code, account_name, root_account_code, root_account_name, analytic,
            md5(analytic), department, credit::numeric(24, 2), remaining_credit, 1, $3::timestamptz
       from lots where remaining_credit > 0`,
    [batchId, endDate, createdAt],
  );
}

async function latestSnapshotDate(client, endDate) {
  const result = await client.query(
    `select max(snapshot_date)::text as snapshot_date from ${CONTROL_TABLE} where snapshot_date <= $1::date`,
    [endDate],
  );
  return result.rows[0]?.snapshot_date || null;
}

module.exports = {
  BALANCE_TABLE,
  CONTROL_TABLE,
  CASH_VIEW,
  PAYABLE_VIEW,
  PROFIT_VIEW,
  addDays,
  assertReportAggregateSchema,
  fullMonthRange,
  insertMonthlyReportAggregates,
  latestSnapshotDate,
  monthEnd,
  monthStart,
};
