create table if not exists public.b02_historical_monthly_values (
  fiscal_year smallint not null,
  fiscal_month smallint not null,
  target_line_code text not null,
  target_line_name text not null,
  amount numeric(24, 2),
  value_status text not null,
  source_standard text not null default 'TT200',
  source_line_codes text[] not null default '{}',
  source_cells text[] not null default '{}',
  mapping_rule text not null,
  source_file_name text not null,
  source_file_sha256 text not null,
  source_sheet_name text not null,
  imported_at timestamptz not null default now(),
  primary key (fiscal_year, fiscal_month, target_line_code),
  constraint b02_historical_month_valid check (fiscal_month between 1 and 12),
  constraint b02_historical_year_valid check (fiscal_year between 2000 and 9999),
  constraint b02_historical_status_valid check (value_status in ('available', 'unavailable')),
  constraint b02_historical_amount_status_valid check (
    (value_status = 'available' and amount is not null)
    or (value_status = 'unavailable' and amount is null)
  ),
  constraint b02_historical_source_standard_valid check (source_standard in ('TT200', 'TT99')),
  constraint b02_historical_source_hash_valid check (source_file_sha256 ~ '^[0-9a-f]{64}$')
);

comment on table public.b02_historical_monthly_values is
  'Monthly historical B02 values mapped to TT99; independent from journal, snapshot and aggregate tables.';
