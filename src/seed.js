/** Load seed.cypher into the graph. `npm run seed` (add --reset to delete the graph first). */
import { connect, seedStatements, GRAPH_NAME } from "./db.js";

let db, graph;
try {
  ({ db, graph } = await connect());
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

if (process.argv.includes("--reset")) {
  try {
    await graph.delete();
    console.log(`deleted graph ${GRAPH_NAME}`);
  } catch {
    /* not existing */
  }
}
const stmts = await seedStatements(new URL("../seed.cypher", import.meta.url));
try {
  for (const s of stmts) await graph.query(s);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
console.log(`seeded ${stmts.length} statements into "${GRAPH_NAME}"`);
await db.close();
