# Cypher the product depends on

All agent queries live in `src/tools.js` (checks) and `src/memory.js` (memory and sign-off). These are handy for the FalkorDB Browser (graph `meds`).

The whole family graph:

```
MATCH (n)-[r]->(m) WHERE NOT n:Action AND NOT n:Session RETURN n, r, m
```

Why Advil is dangerous for Kamala: ingredient → class → interaction → class → ingredient → her medicine:

```
MATCH (:Patient {name:'Kamala Iyer'})-[:HAS_RX]->(:Rx {active:true})-[:OF]->(cur:Drug)-[:CONTAINS]->(ci:Ingredient)
MATCH (:Drug {brand:'Advil'})-[:CONTAINS]->(ni:Ingredient)
MATCH (ni)-[:IN_CLASS*0..1]->(a), (ci)-[:IN_CLASS*0..1]->(b)
MATCH (a)-[x:INTERACTS_WITH]-(b)
RETURN ni.name, a.name, x.severity, x.effect, b.name, ci.name, cur.brand
```

`*0..1` makes `a` either the ingredient itself or its class, so ingredient-level and class-level rules come from one pattern. `-[x:INTERACTS_WITH]-` is undirected, so each interaction is stored only once.

Same visual in the Browser:

```
MATCH p1=(:Drug {brand:'Advil'})-[:CONTAINS]->(:Ingredient)-[:IN_CLASS]->(a)-[:INTERACTS_WITH]-(b)<-[:IN_CLASS]-(:Ingredient)<-[:CONTAINS]-(:Drug)<-[:OF]-(:Rx)<-[:HAS_RX]-(:Patient {name:'Kamala Iyer'})
RETURN p1
```

Hidden duplicate ingredient (NyQuil and Tylenol both contain acetaminophen):

```
MATCH (:Patient {name:'Kamala Iyer'})-[:HAS_RX]->(:Rx {active:true})-[:OF]->(cur:Drug)-[:CONTAINS]->(i:Ingredient)<-[:CONTAINS]-(:Drug {brand:'NyQuil'})
RETURN cur.brand, i.name, i.note
```

Allergy recorded at the class level:

```
MATCH (p:Patient {name:'Kamala Iyer'})-[al:ALLERGIC_TO]->(x)
MATCH (:Drug {brand:'Amoxil'})-[:CONTAINS]->(ni:Ingredient)-[:IN_CLASS*0..1]->(x)
RETURN ni.name, x.name, al.reaction
```

Age-based caution (uses a node property in WHERE):

```
MATCH (p:Patient {name:'Kamala Iyer'}), (:Drug {brand:'NyQuil'})-[:CONTAINS]->(ni:Ingredient)-[:IN_CLASS*0..1]->(a)-[x:CAUTION_IN]->(g:AgeGroup)
WHERE p.age >= g.min_age
RETURN ni.name, a.name, g.name, x.reason
```

Who to call: the prescriber of the conflicting medicine:

```
MATCH (:Patient {name:'Kamala Iyer'})-[:HAS_RX]->(rx:Rx)-[:OF]->(:Drug {brand:'Coumadin'})
MATCH (doc:Clinician)-[:PRESCRIBED]->(rx)
RETURN doc.name, doc.role
```

Options for the same indication:

```
MATCH (:Drug {brand:'Advil'})-[:TREATS]->(n:Indication)<-[:TREATS]-(alt:Drug)
RETURN alt.brand, n.name
```

Memory (Track 02): every check and the clinician's decision:

```
MATCH (a:Action {kind:'check'})-[:FOR_PATIENT]->(p:Patient), (a)-[:ON_DRUG]->(d:Drug)
OPTIONAL MATCH (c:Clinician)-[r:REVIEWED]->(a)
RETURN p.name, d.brand, a.level, a.status, c.name, r.note, a.ts ORDER BY a.ts DESC
```

Memory subgraph for the Browser:

```
MATCH (s:Session)<-[:IN_SESSION]-(a:Action)-[r]->(x) OPTIONAL MATCH (c:Clinician)-[rv:REVIEWED]->(a) RETURN s, a, r, x, c, rv
```

Login scope: a session exists only if the user cares for the patient:

```
MATCH (u {id:$user})-[:CARES_FOR]->(p:Patient {id:$patient})
CREATE (s:Session {id:$id, started:$ts})-[:BY]->(u), (s)-[:ABOUT]->(p)
RETURN s.id
```

Who can see whom:

```
MATCH (u)-[:CARES_FOR]->(p:Patient) RETURN u.name, labels(u)[0] AS kind, p.name
```

Sign-off enforced in the graph: only the logged-in clinician on the patient's care team can decide, and only on a pending check:

```
MATCH (a:Action {id:$id, status:'pending'})-[:FOR_PATIENT]->(p:Patient)<-[:CARES_FOR]-(c:Clinician {id:$clinician})
SET a.status = $decision
CREATE (c)-[:REVIEWED {decision:$decision, note:$note, ts:$ts}]->(a)
RETURN a.id, p.name
```

Access requests: who asked whom, and what was decided:

```
MATCH (r:AccessRequest)-[:FROM]->(u), (r)-[:TO]->(c:Clinician)
OPTIONAL MATCH (r)-[:FOR_PATIENT]->(p:Patient)
RETURN u.name, labels(u)[0] AS kind, c.name, r.kind, r.status, p.name, r.note ORDER BY r.created
```

Approving a caregiver's request: the doctor can only link the caregiver to one of the doctor's own patients:

```
MATCH (r:AccessRequest {id:$id, status:'pending'})-[:TO]->(c:Clinician {id:$clinician}), (r)-[:FROM]->(u:Caregiver),
      (c)-[:CARES_FOR]->(p:Patient {id:$patient})
SET r.status = 'approved'
MERGE (u)-[e:CARES_FOR]->(p) ON CREATE SET e.via = 'request', e.approved_by = $clinician
```
