# sap-dcd-mcp

MCP server exposing SAP's **Digital Contract Data (DCD) Cockpit** (Fiori app
`mdsdlcdcdcockpit`, OData v2 service `ZDCD_SRV;v=0002`) as headless tools. It is the
richest *signed-contract-terms* data plane SAP internal has: contract headers, line
items, ~130 legal clause fields, and downloadable signed-contract PDFs — all keyed by
customer ERP number.

Fully headless — no Chrome/CDP at request time. Reads go through the shared `sap-auth`
SSO cookie (`~/.sap-mcp/auth.json`), the same mechanism as sap-harmony / sap-one360 /
sap-material-map. The first call warms the `sapit-finance-prod-eagle` launchpad domain
via headless SAML SSO automatically.

## Tools

| Tool | Purpose |
|---|---|
| `dcd_whoami` | Auth/reachability check ($metadata). Call first if others auth-error. A 403 = missing DCD Fiori role (authorization, not a bug). |
| `dcd_search(term)` | Free-text customer search → `ERPNUMBER` (+ name, country, active-case count). |
| `dcd_customer_contracts(erp)` | Contract headers (Overview) + line items (Products) for a customer. |
| `dcd_contract_clauses(erp, caseId?)` | ~130 legal/commercial clause fields; optionally one case. |
| `dcd_contract_documents(caseId)` | Document catalog for a case (metadata only). |
| `dcd_download_contract(caseId, documentId?, outDir?)` | Download signed-contract PDF(s) to disk. |

## CLI

```bash
node src/cli.mjs whoami
node src/cli.mjs search Amperex
node src/cli.mjs contracts 2982402
node src/cli.mjs clauses 2982402 3063438814
node src/cli.mjs documents 3063438814
node src/cli.mjs download 3063438814                 # all "Contract Documents"
node src/cli.mjs download 3063438814 <documentId> <dir>
```

## Cross-system chain (Harmony → DCD)

To pull the original signed contract behind a Harmony renewal opp:

1. Harmony `opp_read(expand=Items)` → item `PREV_CONTR_ID` (8-digit CRM order) + header
   `ACCOUNT_ERP_ID` (the customer ERP number — the bridge to DCD).
2. `dcd_customer_contracts(ACCOUNT_ERP_ID)` → match the header whose `SALES_DOC_ID`
   equals `PREV_CONTR_ID` left-padded to 10 digits (`63247134` → `0063247134`) → its `CASE_ID`.
3. `dcd_download_contract(CASE_ID)`.

This orchestration lives in the caller (a skill or the model), never inside a tool — the
MCP only knows ERPNUMBER / caseId / documentId.

## The OData contract (verified 2026-07-11, headless GET, `$format=json`)

Base: `…/51c308db-….mdsdlcdcdcockpit.mdsdlcdcdcockpit/sap/opu/odata/sap/ZDCD_SRV;v=0002`.
The CF approuter GUID can rotate on redeploy — override the whole app root with the
`DCD_BASE` env var if reads start returning 404.

Quirks encoded in `dcd-client.mjs` (each cost a probe to find):

- **Filter every `Account_*` entity by `ERPNUMBER`**, never `CASE_ID` (a `CASE_ID` filter
  returns 0 rows). Rows carry `CASE_ID` for client-side correlation.
- **Customer search uses the GW `search=` url param**, not `$filter=substringof` (which
  returns a `__count` but empty results). And `Account_SearchSet` returns *fewer* rows as
  `$top` grows (`$top=8`→13, `$top=25`→0) — the tool pins a small `$top`.
- **`CmsDocumentsSet` filters by `CaseId` only.** `CaseGuid` is `Edm.String` — passing a
  `guid'…'` literal → HTTP 400.
- **PDF bytes come only from the media entity `CmsAttachment`** (and `Xreference_Attach`)
  via `/$value`. `CmsDocuments` is NOT a media entity (its `/$value` → 400) — it is only the
  metadata catalog. The `CaseGuid` in the key predicate is **uppercase, no dashes**.
- `GetCaseGUID` returns the guid nested at `d.GetCaseGUID.CaseGuid`.

## Auth / role scope

Reads require the DCD Fiori role on the caller's SAP account. Without it the gateway
returns 403 (auth-shaped) — that's an authorization gap, not a code fault. `dcd_whoami`
is the quickest way to confirm the SSO cookie is accepted.
