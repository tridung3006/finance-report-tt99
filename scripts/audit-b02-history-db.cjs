const dotenv = require("dotenv");
const { Pool } = require("pg");

dotenv.config({ quiet: true });

async function main() {
  const pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const access = await pool.query(
      `select current_user,
              to_regnamespace('reporting')::text as reporting_schema,
              has_schema_privilege(current_user, 'public', 'usage') as can_use_public,
              has_schema_privilege(current_user, 'public', 'create') as can_create_public,
              to_regclass('public.b02_historical_monthly_values')::text as existing_table`,
    );
    const relations = await pool.query(
      `select n.nspname as schema_name, c.relname, c.relkind
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'reporting')
          and c.relkind in ('r', 'v', 'm')
        order by c.relname`,
    );
    console.log(JSON.stringify({ access: access.rows[0], relations: relations.rows }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
