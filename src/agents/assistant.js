/**
 * Assistant: LLM tool loop over FalkorDB, scoped to one logged-in session (one user, one patient).
 * Hands safety questions to the checker agent and keeps an audit trail in the graph.
 */
import { TOOL_SPECS, patientInfo } from "../tools.js";
import { history, recordAction } from "../memory.js";
import { checkMedication } from "./checker.js";

export function systemPrompt(session) {
  const { user, patient } = session;
  return `You help ${user.name} (${user.role}) with the medicines of ONE patient: ${patient.name}, age ${patient.age}.
Every question in this session is about ${patient.name}, even when it says "she", "he", "mom" or "dad". You cannot see any other patient; if asked about someone else, say they need to switch patient.
Answer only from the graph via tools. If the graph has no data, say so; never fill gaps from general knowledge.
For any "is it safe / can they take / should they start" question, call check_medication and pass on its level, reasons and who to contact.
Use recall_history for "what did we decide / what happened last time" and patient_info for medicines, conditions, allergies and care team.
You are a decision aid, not a clinician: never tell someone to start, stop or change a medicine; tell them who to ask. Be concise and kind.`;
}

export async function ask(graph, llm, question, session, { maxSteps = 6, log = () => {} } = {}) {
  if (!session?.patient?.id) throw new Error("no active session: log in and pick a patient first");
  const system = systemPrompt(session);
  const messages = [{ role: "user", content: question }];
  for (let step = 0; step < maxSteps; step++) {
    const r = await llm.chat({ system, messages, tools: TOOL_SPECS });
    if (!r.toolCalls.length) {
      // Audit trail: what the assistant told whom, about which patient.
      await recordAction(graph, {
        session: session.id,
        agent: "assistant",
        kind: "answer",
        summary: `Q: ${question} | A: ${r.text}`,
        patient: session.patient.id,
      });
      return r.text;
    }
    messages.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls });
    for (const call of r.toolCalls) {
      let out;
      try {
        out = await dispatch(graph, llm, call, session, { log });
      } catch (e) {
        out = { error: e.message };
      }
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(out).slice(0, 8000),
      });
    }
  }
  return "Stopped: too many tool steps.";
}

/** Runs a tool call. The patient always comes from the session, never from the model's arguments. */
export async function dispatch(graph, llm, call, session, { log = () => {} } = {}) {
  const { name, args = {} } = call;
  const patient = session.patient.id;
  log(`[tool ${name}] ${JSON.stringify(args)} (patient ${session.patient.name})`);
  if (name === "patient_info") return patientInfo(graph, patient, args.topic || "all");
  if (name === "recall_history") return history(graph, { patient, drug: args.drug || "" });
  if (name === "check_medication") {
    log(`[handoff assistant -> checker] ${session.patient.name} + ${args.drug}`);
    const c = await checkMedication(graph, patient, args.drug, { session: session.id, llm });
    if (c.error) return { error: c.error };
    log(`[checker] level=${c.level} findings=${c.findings.length} action=${c.actionId ?? "-"}`);
    return {
      level: c.level,
      report: c.summary,
      explanation: c.explanation,
      actionId: c.actionId,
      needsClinicianReview: true,
    };
  }
  throw new Error(`unknown tool ${name}`);
}
