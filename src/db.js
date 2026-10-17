/** FalkorDB connection helpers. Env: FALKORDB_URL or FALKORDB_HOST/PORT/USERNAME/PASSWORD, FALKORDB_GRAPH */
import { readFile } from "node:fs/promises";

export const GRAPH_NAME = process.env.FALKORDB_GRAPH || "meds";

export async function connect() {
  const { FalkorDB } = await import("falkordb");
  const opts = process.env.FALKORDB_URL
    ? { url: process.env.FALKORDB_URL }
    : {
        socket: {
          host: process.env.FALKORDB_HOST || "127.0.0.1",
          port: Number(process.env.FALKORDB_PORT || 6381),
        },
        username: process.env.FALKORDB_USERNAME || undefined,
        password: process.env.FALKORDB_PASSWORD || undefined,
      };
  let db;
  try {
    db = await FalkorDB.connect(opts);
  } catch (e) {
    const where = process.env.FALKORDB_URL
      ? "FALKORDB_URL"
      : `${opts.socket.host}:${opts.socket.port}`;
    const err = new Error(
      `Cannot reach FalkorDB at ${where} (${e.code || e.message}). Start it with ` +
        "`docker run -p 6381:6379 -it --rm falkordb/falkordb:latest` or set FALKORDB_URL in .env. See README > Troubleshooting.",
    );
    err.code = "FALKORDB_UNREACHABLE";
    throw err;
  }
  db.on?.("error", (e) => console.error("FalkorDB error", e.message));
  return { db, graph: db.selectGraph(GRAPH_NAME) };
}

/** Normalise falkordb results into an array of plain row objects. */
export function rows(result) {
  return result?.data ?? [];
}

/** Run a query with params; works with real Graph or a mock exposing query(q, {params}). */
export async function run(graph, cypher, params = {}) {
  return rows(await graph.query(cypher, { params }));
}

/** Split seed.cypher into statements (one per line, ignoring comments). */
export async function seedStatements(path) {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"));
}
