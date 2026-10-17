/** Mock FalkorDB Graph: records queries and answers by first matching rule. */
export function mockGraph(rules = []) {
  const calls = [];
  return {
    calls,
    async query(cypher, opts = {}) {
      calls.push({ cypher, params: opts.params || {} });
      for (const [match, data] of rules) {
        if (
          typeof match === "string"
            ? cypher.includes(match)
            : match.test(cypher)
        )
          return {
            data: typeof data === "function" ? data(opts.params || {}) : data,
          };
      }
      return { data: [] };
    },
  };
}
