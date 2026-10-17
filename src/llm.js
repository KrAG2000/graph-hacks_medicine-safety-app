/**
 * Pluggable LLM provider. LLM_PROVIDER = openai | anthropic | offline (auto-detected from keys).
 * Interface: chat({system, messages, tools}) -> {text, toolCalls:[{id,name,args}]}
 * Messages use a neutral shape: {role:'user'|'assistant'|'tool', content, toolCalls?, toolCallId?, name?}
 */
export function pickProvider(env = process.env) {
  const p = (env.LLM_PROVIDER || "").toLowerCase();
  if (p) return p;
  if (env.OPENAI_API_KEY) return "openai";
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  return "offline";
}

export function createLLM(env = process.env, fetchImpl = globalThis.fetch) {
  const provider = pickProvider(env);
  if (provider === "openai") return openai(env, fetchImpl);
  if (provider === "anthropic") return anthropic(env, fetchImpl);
  if (provider === "offline") return offline();
  throw new Error(`unknown LLM_PROVIDER ${provider}`);
}

function openai(env, fetchImpl) {
  const base = env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = env.LLM_MODEL || "gpt-4o-mini";
  return {
    name: "openai",
    async chat({ system, messages, tools }) {
      const msgs = [{ role: "system", content: system }];
      for (const m of messages) {
        if (m.role === "tool")
          msgs.push({
            role: "tool",
            tool_call_id: m.toolCallId,
            content: m.content,
          });
        else if (m.role === "assistant" && m.toolCalls?.length)
          msgs.push({
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls.map((t) => ({
              id: t.id,
              type: "function",
              function: { name: t.name, arguments: JSON.stringify(t.args) },
            })),
          });
        else msgs.push({ role: m.role, content: m.content });
      }
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: msgs,
          tools: tools.map((t) => ({ type: "function", function: t })),
        }),
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
      const msg = (await res.json()).choices[0].message;
      return {
        text: msg.content || "",
        toolCalls: (msg.tool_calls || []).map((t) => ({
          id: t.id,
          name: t.function.name,
          args: JSON.parse(t.function.arguments || "{}"),
        })),
      };
    },
  };
}

function anthropic(env, fetchImpl) {
  const model = env.LLM_MODEL || "claude-haiku-4-5";
  return {
    name: "anthropic",
    async chat({ system, messages, tools }) {
      const msgs = [];
      for (const m of messages) {
        if (m.role === "tool") {
          const block = {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: m.content,
          };
          const last = msgs[msgs.length - 1];
          if (
            last?.role === "user" &&
            Array.isArray(last.content) &&
            last.content[0]?.type === "tool_result"
          )
            last.content.push(block);
          else msgs.push({ role: "user", content: [block] });
        } else if (m.role === "assistant" && m.toolCalls?.length) {
          msgs.push({
            role: "assistant",
            content: [
              ...(m.content ? [{ type: "text", text: m.content }] : []),
              ...m.toolCalls.map((t) => ({
                type: "tool_use",
                id: t.id,
                name: t.name,
                input: t.args,
              })),
            ],
          });
        } else msgs.push({ role: m.role, content: m.content });
      }
      const res = await fetchImpl(
        env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            system,
            messages: msgs,
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }),
        },
      );
      if (!res.ok)
        throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
      const body = await res.json();
      return {
        text: body.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n"),
        toolCalls: body.content
          .filter((b) => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, args: b.input })),
      };
    },
  };
}

/** No-key fallback: keyword routing to a single tool call, then a readable version of the result. Good for demos/tests.
 * The patient is never routed here: the session decides it. */
export function offline() {
  const DRUGS = [
    "advil", "ibuprofen", "aleve", "naproxen", "tylenol", "acetaminophen", "nyquil", "mucinex",
    "guaifenesin", "amoxil", "amoxicillin", "biaxin", "clarithromycin", "zithromax", "azithromycin",
    "coumadin", "warfarin", "metformin", "lisinopril", "lipitor", "atorvastatin", "norvasc",
    "amlodipine", "aspirin",
  ];
  const rows = (v) =>
    v.length
      ? v
          .map((r) =>
            Object.entries(r)
              .filter(([k, x]) => x !== null && x !== "" && x !== false && !k.endsWith("_id"))
              .map(([k, x]) => `${k}: ${x}`)
              .join(" | "),
          )
          .join("\n")
      : "none in the graph";
  const format = (content) => {
    let v;
    try {
      v = JSON.parse(content);
    } catch {
      return content;
    }
    if (v?.error) return `Sorry: ${v.error}`;
    if (v?.report)
      return `${v.explanation || v.report}\n(Recorded as ${v.actionId ?? "an unsaved check"}; a clinician on the care team must review it.)`;
    if (Array.isArray(v) && v[0]?.kind)
      return v
        .map(
          (h) =>
            `${(h.ts || "").slice(0, 10)} ${h.drug ?? "-"}: checker said ${String(h.level || "-").toUpperCase()}, decision: ${h.status}` +
            (h.reviewer ? ` by ${h.reviewer}: "${h.note}"` : ""),
        )
        .join("\n");
    if (Array.isArray(v)) return v.length ? rows(v) : "Nothing in the graph for that.";
    if (v && typeof v === "object")
      return Object.entries(v)
        .map(([k, x]) =>
          `${k.replace("_", " ")}:\n${Array.isArray(x) && typeof x[0] === "object" ? rows(x) : (x.length ? x.join(", ") : "none in the graph")}`,
        )
        .join("\n");
    return content;
  };
  return {
    name: "offline",
    async chat({ messages }) {
      const last = messages[messages.length - 1];
      if (last.role === "tool") return { text: format(last.content), toolCalls: [] };
      const q = String(last.content).toLowerCase();
      const words = q.match(/[a-z]+/g) || [];
      const drug = DRUGS.find((d) => words.includes(d));
      const call = (name, args) => ({
        text: "",
        toolCalls: [{ id: `call-${Date.now()}`, name, args }],
      });
      if (/last time|before|history|decid|previous|reviewed|earlier/.test(q))
        return call("recall_history", drug ? { drug } : {});
      if (drug) return call("check_medication", { drug });
      if (/who|doctor|care team|pharmacist/.test(q)) return call("patient_info", { topic: "care_team" });
      if (/allerg/.test(q)) return call("patient_info", { topic: "allergies" });
      if (/condition|diagnos/.test(q)) return call("patient_info", { topic: "conditions" });
      if (/taking|medicine|medication|meds|pills/.test(q)) return call("patient_info", { topic: "medications" });
      return call("patient_info", { topic: "all" });
    },
  };
}
