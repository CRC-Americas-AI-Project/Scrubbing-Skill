---
name: scrubbing
description: >
  Executa scrubbing completo de uma oportunidade SAP: lê Harmony, DCD/CMS,
  baixa e analisa o contrato PDF via pdftotext, valida OBV, calcula IPCA via
  BCB série 433 e preenche todos os campos de Renewal Execution no Harmony.
  100% headless via MCP Scrubbing unificado (Harmony + DCD em um único servidor).
  v3.0 — MCP unificado + uplift sempre 3.30% no campo + IPCA somente na nota ZRE6.
  Use quando o usuário disser "scrubbing", "scrub", "analisar oportunidade" ou fornecer um OPP_ID.
argument-hint: <OPP_ID>
arguments: [opp_id]
allowed-tools: >
  Bash
user-invocable: true
---

# Scrubbing de Oportunidade SAP — Instrução para Joule

Processo oficial SAP CRC de análise e atualização de oportunidades no Harmony antes da cotação.
Baseado em: *How to Guide: Scrubbing Opportunities in CRM/HQ 2026* + *Opportunity Description Naming Convention*.

Se o OPP_ID não for informado, perguntar: "Qual é o OPP_ID para scrubbing?"

---

## REGRA DE OURO — Sessão expirada em qualquer ponto

**Se QUALQUER chamada a qualquer ferramenta retornar erro de autenticação (401 / 403 / CSRF inválido / sessão expirada / fetch failed / SAML redirect) — em QUALQUER fase do scrubbing:**

1. Chamar imediatamente: `renew_auth()` ← MCP tool do servidor unificado
2. Aguardar retorno (até ~60s) — sap-auth abre Edge com SSO corporativo automaticamente
3. Repetir a chamada que falhou e continuar de onde parou

**Se `renew_auth()` retornar `ok: false` com erro técnico** (sem browser, Edge não encontrado, timeout):

> "A renovação automática falhou: [mensagem]. Por favor:
> 1. Abra o Microsoft Edge
> 2. Acesse Harmony: `https://sapit-sales-prod-budgie.launchpad.cfapps.eu10.hana.ondemand.com/1c83fff3-0c88-41fa-a608-c0fa5d3dec6f.hdm.hdm/index.html`
> 3. Aguarde o login SSO automático
> 4. Acesse DCD: `https://sapit-finance-prod-eagle.launchpad.cfapps.eu10.hana.ondemand.com/51c308db-7700-446c-96ff-f0f82d613117.mdsdlcdcdcockpit.mdsdlcdcdcockpit/index.html`
> 5. Me avise quando terminar."

---

## Regras operacionais obrigatórias

- **IS_EDITABLE:** verificar antes de qualquer escrita. Se `false` → análise de referência apenas, sem chamadas `harmony_set_*`.
- **STATUS E0002/E0005:** análise-only, sem edição.
- **Auto Renewal vs Active Renewal:** fonte primária = texto do PDF. "renovados automaticamente" = Auto. "A SAP e o Cliente podem concordar em renovar..." = Active. Active Renewal é **deviation obrigatória**.
- **silentNoOp:true com changedNotes preenchido** = falso positivo CRLF/LF — notas gravadas com sucesso.
- **NUNCA usar `harmony_set_risk_notes`** — usar sempre `harmony_set_renewal_execution_notes`.

---

## FASE 0 — Autenticação SAP

**Executar sempre antes de qualquer outra fase.**

### 0.1 Verificar auth (paralelo)

```
harmony_whoami()
dcd_whoami()
```

- Se ambos retornam OK → prosseguir para FASE 1.
- Se qualquer um retorna erro (401 / 403 / SAML / fetch failed) → FASE 0.2.

### 0.2 Renovação automática

```
renew_auth()
```

`renew_auth` é um MCP tool do servidor unificado — chama sap-auth que abre Edge com SSO corporativo automaticamente. Aguardar até ~60s.

Após conclusão → repetir `harmony_whoami()` + `dcd_whoami()` em paralelo.

- Se OK → prosseguir para FASE 1.
- Se `renew_auth` retornar `ok: false` com erro técnico → FASE 0.3.

### 0.3 Fallback manual (somente se renew_auth falhar com erro técnico)

Informar o usuário:

> "A renovação automática falhou: [mensagem]. Por favor:
> 1. Abra o Microsoft Edge
> 2. Acesse Harmony: `https://sapit-sales-prod-budgie.launchpad.cfapps.eu10.hana.ondemand.com/1c83fff3-0c88-41fa-a608-c0fa5d3dec6f.hdm.hdm/index.html`
> 3. Aguarde o login SSO automático
> 4. Acesse DCD: `https://sapit-finance-prod-eagle.launchpad.cfapps.eu10.hana.ondemand.com/51c308db-7700-446c-96ff-f0f82d613117.mdsdlcdcdcockpit.mdsdlcdcdcockpit/index.html`
> 5. Me avise quando terminar."

Após confirmação → repetir `harmony_whoami()` + `dcd_whoami()` antes de prosseguir.

---

## FASE 1 — Ler o Harmony

Chamar em paralelo:
- `harmony_opp_read(oppId, expand: "PartiesInvolved,Items,Attributes")`
- `harmony_opp_list_quotes(oppId)`
- `harmony_messages_set(oppId, type: "E")`
- `harmony_messages_set(oppId, type: "W")`
- `harmony_read_renewal_execution(oppId)`

Extrair obrigatoriamente:

| Campo | Uso |
|---|---|
| `ACCOUNT_NAME` / `ACCOUNT_ERP_ID` | Cliente / ERP para DCD |
| `DESCRIPTION` | Título atual — verificar naming convention |
| `OWNER_NAME` | CRE |
| `STATUS` | E0001 / E0007 / E0002 / E0005 / E0004 / E0003 |
| `IS_EDITABLE` | Se false → análise apenas |
| `EXPECT_END` | Close Date — calcular D-30 |
| `RENEWAL_CONTRACT_TYPE` | EEI? |
| `Items[].PRODUCT_DESCR` | Produtos |
| `Items[].ORDER_BASE_VALUE` | OBV de cada item |
| `Items[].PREV_CONTR_ID` | Predecessores — registrar IDs únicos |
| `Items[].PREV_CONTR_ITEM_END_DATE` | Data fim predecessor (para IPCA) |
| `Items[].UPLIFT` | Uplift atual |
| `Items[].IS_FIRST_REN` | `"X"` = primeira renovação |
| `PartiesInvolved` | AO = role `ZOZOPA01` / CRE = role `ZOZOCREX` ou `ZOZOPO01` |
| `Attributes[BUSINESS_MODEL]` | Ex: Cloud Choice Flex |

Registrar o que já está preenchido em `harmony_read_renewal_execution` para não sobrescrever.

### Análise do título (naming convention oficial SAP)

**Formato:** `#[HASHTAG] [Customer Name] Q[N]-[YY]`

**Tabela LOB por Sub-Solution Area:**

| Sub-Solution Area | #LOB |
|---|---|
| BTP Other, CIAM (CDC), SAP Build, SAP Integration Suite, Enterprise Agreements | `#BTP` |
| SuccessFactors (qualquer módulo SFSF), SmartRecruiters | `#HCM` |
| Sales Performance Management / SAP Incentive Management (Callidus Cloud) | `#SPM` |
| Emarsys, Commerce, Marketing, Sales and Service | `#CX` |
| Artificial Intelligence, BDC, Data & Analytics Private, Database Cloud | `#DAI` |
| Ariba, Fieldglass, Finance, GRC, Quote to Cash, S/4HANA Finance, Treasury | `#FSM` |
| Taulia | `#TAU` |
| Business Network, SCM, Make & Deliver, Operate & Service, Plan | `#SCM` |
| Customer-Specific Applications, S/4HANA Private | `#CERP` |
| HEC IaaS | `#HEC` |
| Qualtrics | `#QLT` |
| B1, ByDesign | `#BYD` |
| Training & Adoption | `#EDU` |
| WalkMe | `#WM` |
| Signavio | `#SIG` |
| LeanIX | `#LIX` |

**Multi-LOB:** produtos em 2+ solution areas → `#MXBOM #[LOB com maior OBV]`

**Quarter SAP (de EXPECT_END):** Jan–Mar = Q2 | Abr–Jun = Q3 | Jul–Set = Q4 | Out–Dez = Q1 (ano seguinte)

**Nome do cliente:** remover sufixos legais (S.A., LTDA., S/A, SA) + Title Case.

---

## FASE 2 — Mapeamento de contratos via DCD

`dcd_customer_contracts(ACCOUNT_ERP_ID)`

Para cada `PREV_CONTR_ID` único:
1. Paddar com zeros à esquerda até 10 dígitos
2. Localizar em `contracts[]` onde `SALES_DOC_ID === prevContrIdPadded`
3. Registrar: `{ caseId, startDate, endDate, aacv, dealType }`

---

## FASE 3 — Baixar o PDF do contrato

```
dcd_contract_documents(caseId)
dcd_download_contract(caseId, outDir: "C:/Users/I779229/Downloads/scrubbing-<oppId>")
```

Se `downloaded: []` → tentar com `documentId` explícito do `skipped`.

**PDF indisponível (DCD sem documentos):**
- Flag: "no documents found in DCD"
- Usar DCD TCV/AACV como referência de OBV
- Calcular IPCA mesmo assim (datas do Harmony como base)
- GTC Date: não preencher
- Uplift Type: CPI Per Annum + nota de incerteza sobre cláusula
- Renewal Type: assumir Auto se opp name indicar; documentar premissa

---

## FASE 4 — Ler o PDF

```bash
pdftotext -layout "<caminho_do_pdf>" -
```

Extrair obrigatoriamente:

| O que extrair | Onde |
|---|---|
| OBV por período (Anexo 1) | Tabela de produtos; se ramp-up → usar valor do **último período** |
| Renewal Type | "renovados automaticamente" = Auto / "podem concordar em renovar" = Active |
| Cláusula IPCA/uplift | §3.2 / §5.4 / §6.4 — aniversário e indexador |
| GTC version | Rodapé `ptBR.v.X-YYYY` → GTC Date = `YYYY-0X-01` |
| Parceiro | §7.3 ou seção de envolvimento do parceiro |

**SAP Store digital orders:** sem rodapé → GTC Date = N/A, não preencher o campo.

---

## FASE 5 — Cálculo IPCA via BCB

> **REGRA ABSOLUTA:** NUNCA usar WebSearch, WebFetch, browser ou qualquer busca online para obter índices IPCA. SEMPRE e exclusivamente Bash + API BCB abaixo. Uma única chamada Bash por predecessor, cobrindo o período completo — NUNCA fazer chamadas individuais por mês ou por ano.

```
Lookback = (Contract Start − 6 meses) → (Contract End − 6 meses)
```

Chamar API BCB série 433 — **uma única chamada por predecessor, cobrindo todo o período:**
```
https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados?formato=json&dataInicial=DD/MM/YYYY&dataFinal=DD/MM/YYYY
```

Via Node.js (único método válido — Windows e macOS):
```bash
node -e "
fetch('https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados?formato=json&dataInicial=DD/MM/YYYY&dataFinal=DD/MM/YYYY')
  .then(r=>r.json()).then(d=>{
    const acc = d.reduce((p,c)=>p*(1+parseFloat(c.valor)/100),1)-1;
    console.log('IPCA acumulado:', (acc*100).toFixed(4)+'%', '| meses:', d.length);
  });
"
```

Calcular: `((1+m1) × (1+m2) × ... × (1+mN)) − 1`

**IPCA já aplicado** = `(Harmony OBV − PDF OBV) / PDF OBV × 100`

**IPCA a sugerir** = total acumulado − já aplicado

**OBV alvo** = `Harmony OBV × (1 + sugerido)`

Meses não publicados → valor parcial + registrar range pendente em ZRE6.

**Se a API BCB falhar** (timeout, sem conectividade) → registrar flag "IPCA pendente — BCB indisponível" no relatório e continuar o scrubbing. Não tentar alternativas via web.

---

## FASE 6 — Preencher o Harmony

**Pré-condição:** IS_EDITABLE = true e STATUS ≠ E0002/E0005.

### 6.0 Título
```
harmony_set_opp_description(oppId, text: "#[HASHTAG] [Cliente] Q[N]-[YY]")
```

### 6.1 Close Date (Auto Renewal)
```
harmony_set_close_date(oppId, date: "YYYY-MM-DD")  ← PREV_CONTR_ITEM_END_DATE − 30 dias
```
`CLOSE_DATE_EDITABLE: false` não impede a escrita — sempre chamar.
- `ok: true` (mesmo com `wasEditable: false`) → atualizado com sucesso
- `ok: false` (backend rejeitou) → registrar no relatório como ação manual

### 6.2 Risk Retention Lever
```
harmony_set_renewal_risk(oppId, riskRetentionLever: "NON")  ← ou "CMI" se CCFlex + churn ativo
```

### 6.3 Campos de Renewal Execution
```
harmony_set_renewal_execution(oppId, patch: {
  obvValidated:    "Y",
  gtcDate:         "YYYY-MM-DD",   ← do rodapé; omitir se SAP Store ou PDF indisponível
  contrUpliftType: "7",            ← "1" se No Increase
  contrUpliftPc:   "3.30",         ← sempre 3.30 (campo padrão; IPCA real apenas na ZRE6)
  negUpliftLang:   "Y",            ← Y se IPCA/tributos mencionados
  gtcDeviations:   "N"             ← "Y" se Active Renewal / pagamento atípico / etc.
})
```

### 6.4 Notas (SEMPRE usar `harmony_set_renewal_execution_notes` — NUNCA `harmony_set_risk_notes`)

```
harmony_set_renewal_execution_notes(oppId, {
  obvValidatedNote:   "<ZRE1>",
  renewalClosePlan:   "<ZRE4>",
  upliftRemarks:      "<ZRE6>",
  perAnnumLanguage:   "<ZRE8>",           ← somente se IPCA confirmado no PDF
  gtcDeviationsText:  "<ZRE3>",           ← somente se GTC Deviations = Y
  redlines:           "<ZREE>",           ← cópia idêntica de ZRE3
  internalRoadblocks: "<ZRED>",           ← somente se há bloqueadores reais
})
```

### Templates de nota

**ZRE1 (OBV Validated) — PDF disponível:**
```
- [N]-month contract | [Auto/Active Renewal]
- Contract OBV (PDF): BRL [valor] → Harmony OBV: BRL [valor] ([delta%] IPCA applied over contract years)
[Scrubbot, DD/MM/YYYY]
```

**ZRE1 — PDF indisponível:**
```
- [N]-month contract | [Auto/Active Renewal — assumed]
- Harmony OBV: BRL [valor] | DCD TCV reference: [moeda] [valor]
- Contract documents not available in DCD — OBV validated against Harmony line items only
[Scrubbot, DD/MM/YYYY]
```

**ZRE4 (Renewal Close Plan):**
```
- CRE: [nome] | AO: [nome]
- [Auto/Active Renewal] — standard close expected
[Scrubbot, DD/MM/YYYY]
```

**ZRE6 (Uplift % Remarks) — Brasil:**
```
- Full duration basis: [N] months ([Start] → [End]) | Lookback: [Start−6m] → [End−6m]
- Total cumulative IPCA: X.XX% ([N] months, [Mmm/YYYY]–[Mmm/YYYY])
- Already applied: X.XX% (PDF OBV: BRL [valor] → Harmony OBV: BRL [valor])
- Suggested to apply on renewal: X.XX% [partial — pending IBGE: Mmm/YYYY–Mmm/YYYY]
- Note: 3.30% entered in Harmony uplift field is the standard placeholder; real suggested rate above
[Scrubbot, DD/MM/YYYY]
```

**ZRE6 (Uplift % Remarks) — LATAM / outros países:**
```
- Contractual flat rate: 3.30% per annum (fixed rate per contract terms — no BCB calculation)
[Scrubbot, DD/MM/YYYY]
```

**ZRE8 (Per Annum Language):**
```
- §X.X: [citação breve da cláusula IPCA — aniversário e indexador]
[Scrubbot, DD/MM/YYYY]
```

### Regras absolutas das notas

**NUNCA incluir:**
- IDs internos: CMS case ID, order numbers, item numbers
- Date ranges de contratos ou itens
- Referência "BCB série 433", janela de lookback, meses individuais com %
- Sub-itens de faturamento (Cloud 90% / Service 10%)
- Componentes de billing ("Items X and Y are billing sub-components of item Z")
- Mecânica de auto-renewal: prazo de aviso, deadline de cancelamento
- Ausência de riscos ou problemas
- Segmento do cliente / lista de produtos

### Ações manuais (não automatizáveis — registrar no relatório)

- **Renewal Type:** registrar como ação manual **somente** se o PDF indicar **Active Renewal**. Se PDF = Auto Renewal (padrão), **não gerar esta flag**.
- **Incremental Increase Block:** definir Increase Type + Increase % por item na UI Harmony

---

## FASE 7 — Relatório (gerar no chat)

```
SCRUBBING CONCLUÍDO — OPP [oppId]
[DD/MM/YYYY]

• Cliente: [nome] | CRE: [nome] | AO: [nome]
• Renewal Type: [Auto / Active]
• Vencimento: [data] | Close Date: [data] (D-30)
• OBV PDF: BRL [valor] → OBV Harmony: BRL [valor] ([delta%])
• IPCA total: [X.XX%] | Já aplicado: [X.XX%] | Sugerido: [X.XX%] [parcial se aplicável] — campo Harmony: 3.30% (padrão)
• OBV alvo renovação: BRL [valor]
• GTC: ptBR.v.[X]-[YYYY] → [data] | Deviations: [N / resumo]

CAMPOS ATUALIZADOS
✓ Título / ✓ Close Date / ✓ Risk Lever / ✓ OBV Validated / ✓ GTC Date
✓ Uplift Type / ✓ Uplift % / ✓ Per Annum Language / ✓ ZRE1 / ✓ ZRE4 / ✓ ZRE6 / ✓ ZRE8

AÇÕES MANUAIS
⚠ Renewal Type: definir como Active Renewal na UI Harmony  ← incluir SOMENTE se PDF = Active Renewal
⚠ Incremental Increase Block: CPI Per Annum + [X.XX%] por item na UI

FLAGS
• [lista ou —]
```

---

## Checklist de conclusão

- [ ] harmony_opp_read — header + Items + PartiesInvolved
- [ ] Quotes, erros e warnings verificados
- [ ] harmony_read_renewal_execution — estado inicial registrado
- [ ] dcd_customer_contracts — todos os PREV_CONTR_ID mapeados a CASE_ID
- [ ] PDF baixado com dcd_download_contract
- [ ] PDF lido via pdftotext: OBV Anexo 1, cláusula IPCA, rodapé GTC, renewal type, parceiro
- [ ] OBV conferido (Harmony vs PDF)
- [ ] IPCA calculado via BCB série 433 (total / já aplicado / a sugerir)
- [ ] OBV alvo calculado
- [ ] harmony_set_opp_description — título corrigido
- [ ] harmony_set_close_date — D-30 (Auto Renewal)
- [ ] harmony_set_renewal_risk — Risk Retention Lever
- [ ] harmony_set_renewal_execution — campos preenchidos
- [ ] harmony_set_renewal_execution_notes — changedNotes preenchido
- [ ] Ações manuais listadas no relatório
