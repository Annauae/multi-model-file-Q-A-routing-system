import pg from "pg";

const { Pool } = pg;

/** @type {pg.Pool | null} */
let pool = null;

export function getPool() {
    if (!pool) {
        const url = (process.env.DATABASE_URL || "").trim();
        if (!url)
            throw new Error("DATABASE_URL 未配置，请在 Router/.env 中设置");
        pool = new Pool({
            connectionString: url,
            max: Math.max(1, parseInt(process.env.DATABASE_POOL_SIZE || "20", 10)),
        });
        pool.on("error", (err) => {
            console.error("[db] pool error:", err);
        });
    }
    return pool;
}

export async function query(text, params) {
    return getPool().query(text, params);
}

export async function withTransaction(fn) {
    const client = await getPool().connect();
    try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    }
    catch (e) {
        await client.query("ROLLBACK");
        throw e;
    }
    finally {
        client.release();
    }
}

export async function verifyConnection() {
    const r = await query("SELECT 1 AS ok");
    return r.rows[0]?.ok === 1;
}

export async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}
