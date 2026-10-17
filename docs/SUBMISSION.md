# Graph Hacks submission kit: Medication Safety Graph

Deadline: Sat Oct 18, 2026, 11:59 PM IST. Site: https://wemakedevs.org/hackathons/falkordb

## Checklist status

- [x] README with setup + graph data model (README.md)
- [x] Cypher the product depends on (README "Graph model", `src/tools.js`, `src/memory.js`, `queries.md`)
- [x] Complete local setup instructions (README "Run it", tested on FalkorDB v4.22.1)
- [x] Tracks named: 01 (Act on Connected Data) + 02 (Memory & Coordination)
- [x] Tests: 37 passing (unit + live integration + live HTTP API)
- [x] Web UI (screenshots in `docs/screenshots/`) (unit + live integration on a throwaway graph)
- [x] Live run with a real LLM (Anthropic, claude-haiku-5-5)
- [ ] Public GitHub repo (push steps below)
- [ ] Demo video (shot list below)

## Push to a public repo

From `med-safety-graph/` (`.gitignore` already excludes node_modules, .env and zips):

```
git init -b main
git add .
git commit -m "Medication Safety Graph: Graph Hacks (FalkorDB) Tracks 01 + 02"
gh repo create med-safety-graph --public --source=. --push \
  --description "Medication safety checker for family caregivers: agents over a FalkorDB drug graph with clinician sign-off and graph memory (Graph Hacks Tracks 01 + 02)"
```

No gh CLI? Create an empty public repo named `med-safety-graph` on github.com, then:
`git remote add origin https://github.com/<you>/med-safety-graph.git && git push -u origin main`

## Short description (paste into the form)

Medication Safety Graph helps family caregivers check whether a new medicine is safe for someone they look after. A caregiver asks something like "Mom has a headache, can she take Advil?". The caregiver assistant hands the question to a safety checker agent. The checker walks a FalkorDB knowledge graph of patients, prescriptions, drugs, ingredients, drug classes, interactions, conditions, allergies and age rules, and returns a STOP/CAUTION level. Each warning comes with the graph path behind it (Advil → ibuprofen → [NSAIDs] ⟷ [Anticoagulants] ← warfarin ← Coumadin). The checker also names who to call: the doctor who prescribed the conflicting medicine, then the pharmacist. It lists options for the same need that have fewer conflicts.

It's a web app, an HTTP API (JWT access tokens and rotating refresh tokens) and a CLI. Patients and caregivers register themselves, pick a doctor from a directory and request access. Nobody gets access to a patient until a doctor approves: for a caregiver, the doctor links them to one of the doctor's own patients. Users see only the patients they CARES_FOR in the graph, and each session is pinned to one patient. The LLM's tools take the patient from the session, never from the prompt. The agents never decide on their own. Every check is stored in the graph as a pending Action, and only the logged-in clinician on that patient's care team can approve or reject it; the graph query enforces that rule. Sessions, checks and decisions all live in the same graph, so in the next session the agents recall what the doctor decided and refuse to raise a rejected medicine again without new information. The LLM only routes questions and rephrases answers. The safety logic is deterministic, unit-tested Cypher and code. It runs with OpenAI, Anthropic or fully offline. The data is illustrative, not medical advice.

## FalkorDB / Cypher highlights

- `(ingredient)-[:IN_CLASS*0..1]->(x)`: one pattern matches both ingredient-level and class-level rules
- Undirected `-[:INTERACTS_WITH]-`, so each interaction is stored once
- Hidden duplicates via shared ingredients: `(cur)-[:CONTAINS]->(i)<-[:CONTAINS]-(new)`
- Who to call: the conflicting medicine's `Rx` → `PRESCRIBED` → clinician
- Alternatives via `(:Drug)-[:TREATS]->(:Indication)<-[:TREATS]-(alt)`, each re-checked against the patient
- Graph memory: `(:Action)-[:IN_SESSION|FOR_PATIENT|ON_DRUG]->()`, conditional linking with `FOREACH … CASE`
- Accounts, access requests and rotating refresh tokens stored in the graph (`(:RefreshToken)-[:ISSUED_TO]->(user)`, `(:AccessRequest)-[:FROM]->(user)`, `-[:TO]->(:Clinician)`); approving a request is a `MERGE (doctor|caregiver)-[:CARES_FOR]->(patient)`
- Login scope in the graph: a Session is only created if `(user)-[:CARES_FOR]->(patient)` exists
- Authorization in the graph: `MATCH (a {status:'pending'})-[:FOR_PATIENT]->(p)<-[:CARES_FOR]-(c:Clinician)` before `CREATE (c)-[:REVIEWED]->(a)`

## Demo video shot list (target 2 to 3 minutes)

1. (15s) The problem: an older parent on five medicines from three doctors. The dangerous combinations come from how things connect, not from any single label.
2. (20s) The web app at http://127.0.0.1:8787: sign-in page with demo accounts, then Priya's view of Kamala.
2b. (20s) FalkorDB Browser at http://localhost:3000, graph `meds`: run the first query in `queries.md` to show Kamala, her medicines, ingredients, classes and doctors.
3. (80s) Terminal: `npm run demo`.
   - Lena registers as a patient and requests Dr. Menon, who approves her and records a stomach ulcer. Advil is then STOP for her.
   - Neha registers as a caregiver and requests Dr. Rao, who links her to Kamala.
   - Priya logs in (show the JWT claims line), and Sam is refused Kamala's record.
   - "Can she take Advil?" gives STOP, with the warfarin path, the kidney-disease path, who to call, and Tylenol as the option she already takes.
   - "Is NyQuil okay?" gives CAUTION, with the hidden acetaminophen duplicate and the age rule; Mucinex is suggested.
4. (20s) The pharmacist logs in, sees the pending checks and rejects NyQuil with a reason; Priya (a caregiver) trying to approve is refused.
5. (25s) A refresh-token replay revokes the whole login. Then Priya logs in again next day: "What did we decide about NyQuil?" recalls the decision. Then Biaxin brings up Dr. Rao's earlier rejection from September.
6. (20s) Back in the Browser, run the Advil path query and the memory subgraph query from `queries.md`.
7. (10s) Close: Tracks 01 + 02, repo link, graph-based login scope, clinician sign-off, works offline or with OpenAI/Anthropic. Illustrative data, not medical advice.

Before recording: start FalkorDB (Docker one-liner in README), `npm install`, `npm run seed`. Optionally put an LLM key in `.env` for plain-language explanations; offline mode prints the deterministic report, which already reads well.
