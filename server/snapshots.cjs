const SNAPSHOT_TABLE = "public.account_balance_snapshots";
const PROFIT_TABLE = "public.monthly_profit_loss_aggregates";
const CASH_TABLE = "public.monthly_cash_flow_movements";
const PAYABLE_TABLE = "public.payable_open_item_snapshots";
const CONTROL_TABLE = "public.monthly_report_aggregate_controls";
const DEFAULT_MIGRATION_MONTH = "2025-12";
const DEFAULT_TIME_ZONE = "Asia/Ho_Chi_Minh";
const { insertMonthlyReportAggregates } = require("./report-aggregates.cjs");
const REQUIRED_COLUMNS = [
  "batch_id",
  "snapshot_date",
  "account_code",
  "account_name",
  "root_account_code",
  "root_account_name",
  "account_analytic",
  "period_debit",
  "period_credit",
  "cumulative_debit",
  "cumulative_credit",
  "debit_balance",
  "credit_balance",
  "source_row_count",
  "created_at",
];

function normalizeMonth(value, label = "month") {
  const text = String(value || "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) {
    const error = new Error(`${label} must use YYYY-MM format`);
    error.status = 400;
    throw error;
  }
  return text;
}

function addMonths(yearMonth, offset) {
  const normalized = normalizeMonth(yearMonth);
  const [year, month] = normalized.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthStart(yearMonth) {
  return `${normalizeMonth(yearMonth)}-01`;
}

function monthEnd(yearMonth) {
  const nextMonthStart = new Date(`${addMonths(yearMonth, 1)}-01T00:00:00.000Z`);
  nextMonthStart.setUTCDate(0);
  return nextMonthStart.toISOString().slice(0, 10);
}

function monthsBetween(fromMonth, toMonth) {
  const from = normalizeMonth(fromMonth, "fromMonth");
  const to = normalizeMonth(toMonth, "toMonth");
  if (from > to) {
    const error = new Error("fromMonth must be before or equal to toMonth");
    error.status = 400;
    throw error;
  }
  const months = [];
  for (let month = from; month <= to; month = addMonths(month, 1)) months.push(month);
  return months;
}

function zonedParts(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function currentLocalMonth(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = zonedParts(now, timeZone);
  return `${parts.year}-${parts.month}`;
}

function lastClosedMonth(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  return addMonths(currentLocalMonth(now, timeZone), -1);
}

async function assertSnapshotSchema(client) {
  const result = await client.query(
    `select column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name = 'account_balance_snapshots'`,
  );
  const found = new Set(result.rows.map((row) => row.column_name));
  const missing = REQUIRED_COLUMNS.filter((column) => !found.has(column));
  if (missing.length) {
    const error = new Error(`Snapshot table is missing required columns: ${missing.join(", ")}`);
    error.status = 500;
    throw error;
  }
  const controls = await client.query(`select to_regclass('${CONTROL_TABLE}') as name`);
  if (!controls.rows[0]?.name) {
    const error = new Error(`Aggregate control table ${CONTROL_TABLE} does not exist; run server/migrations/005_report_aggregate_controls.sql`);
    error.status = 500;
    throw error;
  }
}

function snapshotBatchId(fromMonth, toMonth) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `snapshot-${fromMonth.replace("-", "")}-${toMonth.replace("-", "")}-${timestamp}-${random}`;
}

async function insertSnapshotMonth(client, { batchId, yearMonth, previousBatchId, createdAt, migrationMonth }) {
  const startDate = monthStart(yearMonth);
  const endDate = monthEnd(yearMonth);
  const previousSnapshotDate = monthEnd(addMonths(yearMonth, -1));
  const isMigrationMonth = yearMonth === migrationMonth;

  if (!isMigrationMonth) {
    // A closed month can legitimately have no balance rows (for example the
    // migration month before the opening journal is imported). The control
    // row, not the number of account rows, proves that the month completed.
    const previous = previousBatchId
      ? await client.query(
        `select exists(
           select 1 from ${CONTROL_TABLE}
            where snapshot_date = $1::date and batch_id = $2
         ) as completed`,
        [previousSnapshotDate, previousBatchId],
      )
      : await client.query(
        `select exists(
           select 1 from ${CONTROL_TABLE}
            where snapshot_date = $1::date
         ) as completed`,
        [previousSnapshotDate],
      );
    if (!previous.rows[0]?.completed) {
      const error = new Error(`Missing previous snapshot ${previousSnapshotDate}; rebuild must start from an earlier month`);
      error.status = 409;
      throw error;
    }
  }

  const previousCte = isMigrationMonth
    ? `select ''::text as account_code, ''::text as account_name, ''::text as root_account_code,
              ''::text as root_account_name, ''::text as account_analytic,
              0::numeric as cumulative_debit, 0::numeric as cumulative_credit,
              0::bigint as source_row_count
         where false and $4::date is not null`
    : `select snapshot.account_code, snapshot.account_name,
              snapshot.root_account_code, snapshot.root_account_name, snapshot.account_analytic,
              snapshot.cumulative_debit, snapshot.cumulative_credit, snapshot.source_row_count
         from ${SNAPSHOT_TABLE} snapshot
         join ${CONTROL_TABLE} control
           on control.snapshot_date = snapshot.snapshot_date
          and control.batch_id = snapshot.batch_id
        where snapshot.snapshot_date = $4::date
          ${previousBatchId ? "and snapshot.batch_id = $5" : ""}`;

  const params = [batchId, startDate, endDate, previousSnapshotDate];
  if (previousBatchId) params.push(previousBatchId);
  params.push(createdAt);
  const createdAtParameter = `$${params.length}`;

  const inserted = await client.query(
    `with previous_snapshot as (
       ${previousCte}
     ),
     monthly_activity as (
       select coalesce(account_code, root_account_code, 'NO_ACCOUNT') as account_code,
              max(coalesce(account_name, '')) as account_name,
              coalesce(root_account_code, '') as root_account_code,
              max(coalesce(root_account_name, '')) as root_account_name,
              coalesce(account_analytic, '') as account_analytic,
              sum(coalesce(debit, 0))::numeric(24, 2) as period_debit,
              sum(coalesce(credit, 0))::numeric(24, 2) as period_credit,
              count(*)::bigint as period_row_count
         from public.journal
        where status = 'Posted'
          and coalesce(account_name, '') not in ('More Account 111/112', 'More Account 131')
          and posting_date >= $2::date
          and posting_date <= $3::date
        group by coalesce(account_code, root_account_code, 'NO_ACCOUNT'),
                 coalesce(root_account_code, ''),
                 coalesce(account_analytic, '')
     ),
     account_keys as (
       select account_code, root_account_code, account_analytic from previous_snapshot
       union
       select account_code, root_account_code, account_analytic from monthly_activity
     ),
     calculated as (
       select keys.account_code,
              coalesce(activity.account_name, previous.account_name, '') as account_name,
              keys.root_account_code,
              coalesce(activity.root_account_name, previous.root_account_name, '') as root_account_name,
              keys.account_analytic,
              coalesce(activity.period_debit, 0)::numeric(24, 2) as period_debit,
              coalesce(activity.period_credit, 0)::numeric(24, 2) as period_credit,
              (coalesce(previous.cumulative_debit, 0) + coalesce(activity.period_debit, 0))::numeric(24, 2) as cumulative_debit,
              (coalesce(previous.cumulative_credit, 0) + coalesce(activity.period_credit, 0))::numeric(24, 2) as cumulative_credit,
              (coalesce(previous.source_row_count, 0) + coalesce(activity.period_row_count, 0))::bigint as source_row_count
         from account_keys keys
         left join previous_snapshot previous using (account_code, root_account_code, account_analytic)
         left join monthly_activity activity using (account_code, root_account_code, account_analytic)
     )
     insert into ${SNAPSHOT_TABLE} (
       batch_id, snapshot_date, account_code, account_name, root_account_code, root_account_name,
       account_analytic, period_debit, period_credit, cumulative_debit, cumulative_credit,
       debit_balance, credit_balance, source_row_count, created_at
     )
     select $1,
            $3::date,
            account_code,
            account_name,
            root_account_code,
            root_account_name,
            account_analytic,
            period_debit,
            period_credit,
            cumulative_debit,
            cumulative_credit,
            greatest(cumulative_debit - cumulative_credit, 0)::numeric(24, 2),
            greatest(cumulative_credit - cumulative_debit, 0)::numeric(24, 2),
            source_row_count,
            ${createdAtParameter}::timestamptz
       from calculated`,
    params,
  );

  await insertMonthlyReportAggregates(client, {
    batchId,
    startDate,
    endDate,
    createdAt,
  });

  const snapshotTotals = await client.query(
    `select count(*)::int as row_count,
            coalesce(sum(cumulative_debit), 0) as debit,
            coalesce(sum(cumulative_credit), 0) as credit,
            coalesce(sum(source_row_count), 0)::bigint as source_rows
       from ${SNAPSHOT_TABLE}
      where batch_id = $1 and snapshot_date = $2::date`,
    [batchId, endDate],
  );
  const journalTotals = await client.query(
    `select count(*)::bigint as source_rows,
            coalesce(sum(debit), 0) as debit,
            coalesce(sum(credit), 0) as credit
       from public.journal
      where status = 'Posted'
        and coalesce(account_name, '') not in ('More Account 111/112', 'More Account 131')
        and posting_date >= $1::date
        and posting_date <= $2::date`,
    [monthStart(migrationMonth), endDate],
  );
  const snapshot = snapshotTotals.rows[0];
  const journal = journalTotals.rows[0];
  const reconciled = Math.abs(Number(snapshot.debit) - Number(journal.debit)) < 0.01
    && Math.abs(Number(snapshot.credit) - Number(journal.credit)) < 0.01
    && String(snapshot.source_rows) === String(journal.source_rows);
  if (!reconciled) {
    const error = new Error(`Snapshot ${endDate} does not reconcile to journal`);
    error.status = 409;
    throw error;
  }
  const profitLossTotals = (await client.query(
    `select coalesce(sum(source_row_count), 0)::bigint as source_rows,
            coalesce(sum(debit), 0)::numeric(24, 2) as debit,
            coalesce(sum(credit), 0)::numeric(24, 2) as credit
       from ${PROFIT_TABLE}
      where batch_id = $1 and month_end = $2::date`,
    [batchId, endDate],
  )).rows[0];
  const rawProfitLossTotals = (await client.query(
    `select count(*)::bigint as source_rows,
            coalesce(sum(j.debit), 0)::numeric(24, 2) as debit,
            coalesce(sum(j.credit), 0)::numeric(24, 2) as credit
       from public.journal j
      where j.status = 'Posted'
        and coalesce(j.account_name, '') not in ('More Account 111/112', 'More Account 131')
        and j.posting_date between $1::date and $2::date
        and regexp_replace(coalesce(j.account_code, j.root_account_code, ''), '^0+', '') ~ '^[5-9]'
        and not exists (
          select 1 from public.journal closing_line
           where closing_line.journal_id = j.journal_id
             and closing_line.status = 'Posted'
             and regexp_replace(coalesce(closing_line.account_code, closing_line.root_account_code, ''), '^0+', '') ~ '^911'
        )`,
    [startDate, endDate],
  )).rows[0];
  const profitLossReconciled = String(profitLossTotals.source_rows) === String(rawProfitLossTotals.source_rows)
    && Math.abs(Number(profitLossTotals.debit) - Number(rawProfitLossTotals.debit)) < 0.01
    && Math.abs(Number(profitLossTotals.credit) - Number(rawProfitLossTotals.credit)) < 0.01;
  if (!profitLossReconciled) {
    const error = new Error(`Profit/loss aggregate ${endDate} does not reconcile to journal`);
    error.status = 409;
    throw error;
  }
  const cashTotals = (await client.query(
    `select count(*)::bigint as movement_count,
            coalesce(sum(amount), 0)::numeric(24, 2) as net_amount
       from ${CASH_TABLE}
      where batch_id = $1 and month_end = $2::date`,
    [batchId, endDate],
  )).rows[0];
  const rawCashTotals = (await client.query(
    `with cash_by_journal as (
       select j.journal_id, sum(coalesce(j.debit, 0) - coalesce(j.credit, 0)) as amount
         from public.journal j
        where j.status = 'Posted'
          and coalesce(j.account_name, '') not in ('More Account 111/112', 'More Account 131')
          and j.posting_date between $1::date and $2::date
          and regexp_replace(coalesce(j.account_code, j.root_account_code, ''), '^0+', '') ~ '^(111|112|113)'
        group by j.journal_id
     )
     select count(*)::bigint as movement_count,
            coalesce(sum(amount), 0)::numeric(24, 2) as net_amount
       from cash_by_journal`,
    [startDate, endDate],
  )).rows[0];
  const cashReconciled = String(cashTotals.movement_count) === String(rawCashTotals.movement_count)
    && Math.abs(Number(cashTotals.net_amount) - Number(rawCashTotals.net_amount)) < 0.01;
  if (!cashReconciled) {
    const error = new Error(`Cash-flow aggregate ${endDate} does not reconcile to journal`);
    error.status = 409;
    throw error;
  }
  const payableTotals = (await client.query(
    `select count(*)::bigint as item_count,
            coalesce(sum(remaining_credit), 0)::numeric(24, 2) as open_amount
       from ${PAYABLE_TABLE}
      where batch_id = $1 and snapshot_date = $2::date`,
    [batchId, endDate],
  )).rows[0];
  await client.query(
    `insert into ${CONTROL_TABLE} (
       snapshot_date, batch_id, balance_source_row_count, balance_debit, balance_credit,
       profit_loss_source_row_count, profit_loss_debit, profit_loss_credit,
       cash_movement_count, cash_net_amount, payable_open_item_count, payable_open_amount, created_at
     ) values ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz)`,
    [endDate, batchId, snapshot.source_rows, snapshot.debit, snapshot.credit,
      profitLossTotals.source_rows, profitLossTotals.debit, profitLossTotals.credit,
      cashTotals.movement_count, cashTotals.net_amount,
      payableTotals.item_count, payableTotals.open_amount, createdAt],
  );
  return {
    yearMonth,
    snapshotDate: endDate,
    rowCount: inserted.rowCount,
    cumulativeDebit: Number(snapshot.debit),
    cumulativeCredit: Number(snapshot.credit),
    sourceRows: Number(snapshot.source_rows),
  };
}

async function rebuildSnapshots(pool, options = {}) {
  const migrationMonth = normalizeMonth(options.migrationMonth || DEFAULT_MIGRATION_MONTH, "migrationMonth");
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const fromMonth = normalizeMonth(options.fromMonth, "fromMonth");
  const toMonth = normalizeMonth(options.toMonth || lastClosedMonth(new Date(), timeZone), "toMonth");
  if (fromMonth < migrationMonth) {
    const error = new Error(`fromMonth cannot be earlier than migration month ${migrationMonth}`);
    error.status = 400;
    throw error;
  }
  let effectiveFromMonth = fromMonth;
  let months = monthsBetween(effectiveFromMonth, toMonth);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '10min'");
    await client.query("select pg_advisory_xact_lock(hashtext('account_balance_snapshots-rebuild-v1'))");
    await assertSnapshotSchema(client);
    if (options.onlyMissing) {
      const existing = await client.query(
        `select distinct to_char(snapshot_date, 'YYYY-MM') as year_month
           from ${CONTROL_TABLE}
          where snapshot_date >= $1::date
            and snapshot_date <= $2::date`,
        [monthStart(effectiveFromMonth), monthEnd(toMonth)],
      );
      const found = new Set(existing.rows.map((row) => row.year_month));
      const firstMissing = months.find((month) => !found.has(month));
      if (!firstMissing) {
        await client.query("COMMIT");
        return { ok: true, skipped: true, batchId: null, fromMonth: effectiveFromMonth, toMonth, createdAt: null, months: [] };
      }
      effectiveFromMonth = firstMissing;
      months = monthsBetween(effectiveFromMonth, toMonth);
    }
    const rebuildStartDate = monthStart(effectiveFromMonth);
    const rebuildEndDate = monthEnd(toMonth);
    // Keep one physical version per month. These deletes are in the same
    // transaction as the rebuild, so a failed rebuild restores the old rows.
    // Delete dependent report artifacts first, then the controlling balance
    // snapshot rows.
    const deleted = {};
    deleted.controls = (await client.query(
      `delete from ${CONTROL_TABLE} where snapshot_date between $1::date and $2::date`,
      [rebuildStartDate, rebuildEndDate],
    )).rowCount;
    deleted.profitLoss = (await client.query(
      `delete from ${PROFIT_TABLE} where month_end between $1::date and $2::date`,
      [rebuildStartDate, rebuildEndDate],
    )).rowCount;
    deleted.cashFlow = (await client.query(
      `delete from ${CASH_TABLE} where month_end between $1::date and $2::date`,
      [rebuildStartDate, rebuildEndDate],
    )).rowCount;
    deleted.payableAging = (await client.query(
      `delete from ${PAYABLE_TABLE} where snapshot_date between $1::date and $2::date`,
      [rebuildStartDate, rebuildEndDate],
    )).rowCount;
    deleted.balances = (await client.query(
      `delete from ${SNAPSHOT_TABLE} where snapshot_date between $1::date and $2::date`,
      [rebuildStartDate, rebuildEndDate],
    )).rowCount;
    const createdAt = new Date().toISOString();
    const batchId = snapshotBatchId(effectiveFromMonth, toMonth);
    const results = [];
    for (let index = 0; index < months.length; index += 1) {
      results.push(await insertSnapshotMonth(client, {
        batchId,
        yearMonth: months[index],
        previousBatchId: index > 0 ? batchId : null,
        createdAt,
        migrationMonth,
      }));
    }
    await client.query("COMMIT");
    return { ok: true, batchId, fromMonth: effectiveFromMonth, toMonth, createdAt, deleted, months: results };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function getSnapshotStatus(pool, options = {}) {
  const migrationMonth = normalizeMonth(options.migrationMonth || DEFAULT_MIGRATION_MONTH, "migrationMonth");
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const closedMonth = lastClosedMonth(new Date(), timeZone);
  const client = await pool.connect();
  try {
    await assertSnapshotSchema(client);
    const result = await client.query(
      `select control.snapshot_date::text,
              control.batch_id,
              count(snapshot.account_code)::int as row_count,
              coalesce(sum(snapshot.cumulative_debit), 0) as cumulative_debit,
              coalesce(sum(snapshot.cumulative_credit), 0) as cumulative_credit,
              coalesce(max(snapshot.created_at), max(control.created_at)) as created_at
         from ${CONTROL_TABLE} control
         left join ${SNAPSHOT_TABLE} snapshot
           on snapshot.snapshot_date = control.snapshot_date
          and snapshot.batch_id = control.batch_id
        group by control.snapshot_date, control.batch_id
        order by control.snapshot_date`,
    );
    const found = new Set(result.rows.map((row) => String(row.snapshot_date).slice(0, 7)));
    const expected = monthsBetween(migrationMonth, closedMonth);
    const missingFromMonth = expected.find((month) => !found.has(month)) || null;
    return {
      migrationMonth,
      timeZone,
      lastClosedMonth: closedMonth,
      missingFromMonth,
      latestSnapshot: result.rows.length ? result.rows[result.rows.length - 1].snapshot_date : null,
      months: result.rows.map((row) => ({
        snapshotDate: row.snapshot_date,
        batchId: row.batch_id,
        rowCount: Number(row.row_count),
        cumulativeDebit: Number(row.cumulative_debit),
        cumulativeCredit: Number(row.cumulative_credit),
        createdAt: row.created_at,
      })),
    };
  } finally {
    client.release();
  }
}

async function createMissingSnapshots(pool, options = {}) {
  const status = await getSnapshotStatus(pool, options);
  if (!status.missingFromMonth) return { ok: true, created: false, status };
  const result = await rebuildSnapshots(pool, {
    ...options,
    fromMonth: status.missingFromMonth,
    toMonth: status.lastClosedMonth,
    onlyMissing: true,
  });
  return { ok: true, created: result.months.length > 0, result, status: await getSnapshotStatus(pool, options) };
}

function startSnapshotScheduler(pool, options = {}) {
  const enabled = options.enabled !== false;
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const scheduleHour = Math.min(23, Math.max(0, Number(options.scheduleHour ?? 3)));
  const intervalMs = Math.max(60_000, Number(options.intervalMs || 15 * 60_000));
  const logger = options.logger || console;
  let lastRunDate = "";
  let running = false;

  async function tick(now = new Date()) {
    if (!enabled || running) return;
    const parts = zonedParts(now, timeZone);
    const localDate = `${parts.year}-${parts.month}-${parts.day}`;
    if (Number(parts.hour) < scheduleHour || lastRunDate === localDate) return;
    running = true;
    try {
      const result = await createMissingSnapshots(pool, options);
      lastRunDate = localDate;
      if (result.created) logger.info?.(`Created missing account balance snapshots through ${result.status.lastClosedMonth}`);
    } catch (error) {
      logger.error?.("Automatic snapshot job failed", error);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => tick(), intervalMs);
  timer.unref?.();
  void tick();
  return { stop: () => clearInterval(timer), tick };
}

module.exports = {
  addMonths,
  createMissingSnapshots,
  getSnapshotStatus,
  lastClosedMonth,
  monthEnd,
  monthStart,
  monthsBetween,
  normalizeMonth,
  rebuildSnapshots,
  startSnapshotScheduler,
};
