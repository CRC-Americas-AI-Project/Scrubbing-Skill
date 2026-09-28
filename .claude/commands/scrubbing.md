---
name: scrubbing
description: >
  Scrubbing de oportunidades SAP no Harmony — processo oficial baseado no How to Guide 2026
  e Naming Convention SAP. Cobre Harmony Quote Opportunities via DCD, multi-contrato,
  calcula IPCA por contrato, atualiza Renewal Execution. Naming convention global oficial SAP.
  100% headless via MCP. Use quando a oportunidade requer o processo oficial SAP CRC.
argument-hint: "[OPP_ID]"
arguments:
  - name: opp_id
    description: "ID da oportunidade no Harmony (ex: 306358820)"
    required: true
allowed-tools:
  - mcp__sap-harmony__harmony_opp_read
  - mcp__sap-harmony__harmony_opp_list_quotes
  - mcp__sap-harmony__harmony_messages_set
  - mcp__sap-harmony__harmony_read_renewal_execution
  - mcp__sap-harmony__harmony_set_opp_description
  - mcp__sap-harmony__harmony_set_close_date
  - mcp__sap-harmony__harmony_set_renewal_execution
  - mcp__sap-harmony__harmony_set_renewal_execution_notes
  - mcp__sap-harmony__harmony_set_renewal_risk
  - mcp__sap-harmony__harmony_deals_list
  - mcp__sap-harmony__harmony_odata_function
  - mcp__sap-dcd__dcd_search
  - mcp__sap-dcd__dcd_customer_contracts
  - mcp__sap-dcd__dcd_contract_documents
  - mcp__sap-dcd__dcd_download_contract
  - Bash
  - Read
  - WebFetch
user-invocable: true
---

# Scrubbing Harmony — How to Guide 2026 (Oficial SAP)

Processo oficial SAP CRC de análise e atualização de oportunidades no Harmony antes da cotação.
Baseado em: *How to Guide: Scrubbing Opportunities in CRM/HQ 2026* + *Opportunity Description Naming Convention* (documentos oficiais SAP).
Implementação: 100% headless via MCP — sem Playwright, sem browser.

---

## Fluxo obrigatório

```
Harmony → DCD → PDF Executado (pdftotext) → Verificar OBV / Uplift / Renewal Type / GTCs → IPCA (BCB)
→ Atualizar Harmony (Naming + Renewal Execution + Risk) → Relatório
```

---

## Pré-requisito: argumento

Se invocado sem argumento, perguntar: "Qual é o OPP_ID?"

---

## Pré-requisito: verificar auth

Testar com `harmony_opp_read(opp_id)`. Se retornar erro de auth: informar que os cookies SAP expiraram e executar o procedimento de renovação de auth (`node ~/.sap-mcp/auto-renew-auth.mjs` ou procedimento manual).

---

## Regras operacionais obrigatórias

- **IS_EDITABLE:** verificar antes de qualquer escrita. Se `false` → análise de referência apenas, sem chamadas `harmony_set_*`.
- **STATUS E0002/E0005:** análise-only, sem edição mesmo se IS_EDITABLE = true.
- **Quote cancelada não para o scrubbing.** Registrar como flag crítica e continuar.
- **Auto Renewal vs Active Renewal:** fonte primária = texto do PDF. "renovados automaticamente" / "renovará automaticamente" / "auto-renew" = Auto. "A SAP e o Cliente podem concordar em renovar..." = Active. Active Renewal é **deviation obrigatória**: registrar em GTC Deviations + cópia idêntica em Redlines.
- **Renewal Close Plan:** incluir CRE (role `ZOZOCREX`) **e** AO (role `ZOZOPA01`).
- **GTC Date:** derivar do rodapé do PDF (`ptBR.v.X-YYYY` → `YYYY-0X-01`). SAP Store digital orders não têm rodapé — GTC Date = N/A, não preencher o campo.
- **Redlines = cópia idêntica de GTC Deviations** — sempre sincronizar.
- **Notas:** inglês, bullet points, aditivo (nunca sobrescrever). Assinatura: `[Scrubbot, DD/MM/YYYY]`.
- **silentNoOp:true com changedNotes preenchido** = falso positivo por divergência `\r\n` vs `\n` — as notas foram gravadas com sucesso.
- **Economia de tokens:** para outputs JSON > 20KB, usar Node.js para extrair apenas os campos necessários.

---

## FASE 1 — Ler Harmony (headless)

### 1.1 Dados da oportunidade

Executar em paralelo:
```
harmony_opp_read(opp_id, expand: "PartiesInvolved,Items,Attributes")
harmony_opp_list_quotes(opp_id)
harmony_messages_set(opp_id, type: "E")
harmony_messages_set(opp_id, type: "W")
harmony_read_renewal_execution(opp_id)
```

Extrair obrigatoriamente:

| Campo OData | Uso |
|---|---|
| `ACCOUNT_NAME` / `ACCOUNT_ERP_ID` | Cliente / ERP para DCD |
| `DESCRIPTION` | Título atual — analisar naming convention |
| `OWNER_NAME` | CRE |
| `STATUS` | E0001 In process \| E0007 New \| E0002 Discontinued \| E0005 Lost \| E0004 Booked \| E0003 Won |
| `IS_EDITABLE` | Se false → análise de referência apenas, sem writes |
| `EXPECT_END` | Close Date — calcular D- até vencimento |
| `RENEWAL_CONTRACT_TYPE` | `"EEI"` ou vazio |
| `RENEWAL_TYPE` | Auto (`"AU"`) ou Active (`"A"`) |
| `ORDER_ID` | Contrato de origem → DCD |
| `Items[].PRODUCT_DESCR` | Produtos |
| `Items[].ORDER_BASE_VALUE` | OBV de cada item |
| `Items[].PREV_CONTR_ID` | **Todos os predecessores** — registrar como array de IDs únicos |
| `Items[].CONTR_START_DATE` / `CONTR_END_DATE` | Datas do item |
| `Items[].PREV_CONTR_ITEM_END_DATE` | Data de fim do predecessor no Harmony (usar para IPCA em auto-renewal chains) |
| `Items[].UPLIFT` | Uplift % atual no Harmony |
| `Items[].RENEWAL_CONTRACT_TYPE` | EEI por item |
| `Items[].IS_FIRST_REN` | `"X"` = primeira renovação; vazio = contrato já foi renovado antes |
| `PartiesInvolved` | AO = role `ZOZOPA01`, CRE = role `ZOZOCREX` |
| `Attributes[BUSINESS_MODEL]` | Ex: Cloud Choice Flex |
| `Attributes[SOLUTION_AREA]` | Ex: SABTP, SAAI, SAINS |

Registrar o que já está preenchido em `harmony_read_renewal_execution` para não sobrescrever acidentalmente.

**Resultado esperado:** array com todos os `PREV_CONTR_ID` únicos (filtrar itens sem predecessor — entitlements, créditos, linhas novas).

### 1.2 Quotes e erros

Registrar:
- Quotes ativas vs canceladas (quote cancelada → flag crítica, continuar)
- Erros/warnings ativos que possam bloquear cotação
- Campos do Renewal Execution já preenchidos (para não sobrescrever)

### 1.3 Análise do título (naming convention oficial SAP)

**Objetivo:** verificar se o título segue o padrão oficial SAP e corrigir automaticamente.

#### Formato obrigatório
```
#[HASHTAG] [Customer Name] Q[N]-[YY]
```
Exemplos: `#HCM Vale Q4-26` | `#MXBOM #CX Natura Q3-27` | `#IQR #M2R Caterpillar Q4-23`

#### Regra 1 — Determinar #LOB (por Sub-Solution Area)

| Sub-Solution Area | Solution Area | #LOB |
|---|---|---|
| BTP Other, CIAM (CDC), Enterprise Agreements, SAP Build, SAP Integration Suite | Business Technology Platform | `#BTP` |
| SuccessFactors Cross, Learning and Talent, Core HR & Payroll Private/Public, SmartRecruiters | Human Capital Management | `#HCM` |
| Sales Performance Management (Callidus Cloud) | Customer Experience | `#SPM` |
| Commerce, Marketing, Sales and Service | Customer Experience | `#CX` |
| Artificial Intelligence, BDC, Data & Analytics Private, Database Cloud | Data & AI | `#DAI` |
| Accounting & Financial Close, Fieldglass, Finance Private, Financial Planning & Analysis, GRC Tax & Trade, Procurement (Ariba), Quote to Cash, Cloud ERP (S/4HANA) Finance, Treasury & Working Capital | Finance and Spend Management | `#FSM` |
| Taulia | Finance and Spend Management | `#TAU` |
| Business Network, Cloud ERP SCM, Make & Deliver, Operate & Service, Plan, SCM Private | Supply Chain Management | `#SCM` |
| Customer-Specific Applications, Cloud ERP (S/4HANA) Private | Cloud ERP Private | `#CERP` |
| HEC IaaS | Other | `#HEC` |
| Experience Management > Qualtrics | Other | `#QLT` |
| ERP for SME (B1, ByD) | Other | `#BYD` |
| Training & Adoption | Other | `#EDU` |
| WalkMe | Other | `#WM` |
| Signavio | Other | `#SIG` |
| LeanIX | Other | `#LIX` |

**Multi-LOB:** se produtos mapearem para 2+ solution areas → `#MXBOM #[LOB com maior OBV somado]`

#### Hashtags de situação

| Hashtag | Situação |
|---|---|
| `#M2R` | Move to RISE (legacy Cloud ERP → RISE) |
| `#ERU` | Early Renewal + Upsell |
| `#OQR` | Out of Quarter Replacement |
| `#IQR` | In Quarter Replacement |
| `#ADMIN` | Administrative Replacement (Clean-Up) |
| `#NONPAY` | Cliente não paga mas será renovado/auto-renovado |
| `#FBLK` | Finance block |
| `#STER` | Short Term Extension |
| `#SWAP` | Replacement — cliente exercendo direito de troca |
| `#TERM` | Termination in progress |
| `#TERMEOQ` | Termination — será Lost até fim do trimestre |
| `#BKUP` | Back-up Renewal (quando Replacement em andamento) |
| `#EOL` | End of Life |
| `#NRR` | Non-Renewal Relevant |
| `#LCPQ` | Legacy Callidus CPQ paper deals |
| `#LIX` | LeanIX on SAP Paper |
| `#LGLIX` | Legacy LeanIX |
| `#WMMV` | SAP Enable Now → WalkMe Move Program |

**Hashtags Low-Touch DELTA Team:**
| Hashtag | Situação |
|---|---|
| `#SITGTC` | SAP Iniciado — digital, ativo por mudança de T&Cs |
| `#SITUP` | SAP Iniciado — digital, ativo por compliance upsell |
| `#SITEOL` | SAP Iniciado — digital, ativo por produto EOL |
| `#CITUP` | Customer Iniciado — digital, ativo por upsell |
| `#CITDOWN` | Customer Iniciado — digital, ativo por down sell |
| `#CITOPT` | Customer Iniciado — digital, ativo por pricing |

#### Regra 2 — Nome do cliente

Usar `ACCOUNT_NAME`, removendo sufixos legais (` S.A.` ` LTDA.` ` LTDA` ` S/A` ` SA` etc.) e aplicando Title Case.
Exemplo: `SUZANO S.A.` → `Suzano`

#### Regra 3 — Quarter e ano

Derivar do **Prior Order End Date** (data de expiração do contrato predecessor no DCD — campo `endDate` do contrato mapeado na Fase 2):
- Jan–Mar → Q1 | Abr–Jun → Q2 | Jul–Set → Q3 | Out–Dez → Q4
- Ano = últimos 2 dígitos do ano de expiração do predecessor

Exemplo: Prior Order End Date = Dez/2026 → **Q4-26** | Mar/2027 → **Q1-27**

> ⚠️ **Não usar EXPECT_END para o quarter.** O quarter reflete quando o contrato existente expira (evento que origina a renovação), não quando a nova negociação deve fechar. Se o close date slippar, o título não muda.

#### Detecção de componentes ausentes

- `#[A-Z]+` presente? → tem LOB
- `Q\d-\d{2}` presente? → tem quarter
- Nome do cliente presente? → verificar substring

**Se tudo correto → nenhuma ação.** Se falta algum componente → corrigir na Fase 7.0.

---

## FASE 2 — Mapeamento de contratos via DCD (headless)

**Objetivo:** mapear cada `PREV_CONTR_ID` ao seu `CASE_ID` no DCD.

```
dcd_customer_contracts(ACCOUNT_ERP_ID)
```

Filtrar itens sem predecessor:
```js
const validItems = items.filter(i => i.PREV_CONTR_ID && i.PREV_CONTR_ID.trim() !== '')
const uniquePrevContrIds = [...new Set(validItems.map(i => i.PREV_CONTR_ID))]
```

Para cada `PREV_CONTR_ID`:
1. Paddar com zeros à esquerda até 10 dígitos: `prevContrId.padStart(10, '0')`
2. Buscar em `contracts[]` onde `SALES_DOC_ID === prevContrIdPadded`
3. Registrar: `{ caseId, salesDocId, aacv, startDate, endDate, dealType }`
4. Se não encontrar match: flag — predecessor não localizado no DCD, continuar

Contratos com o mesmo `CASE_ID` → agrupar (são o mesmo contrato).

Classificar por data de início:
- Mais antigo = **Contrato Inicial**
- Demais = **Aditivo 1, Aditivo 2, ...**

**Edge case — CCFlex auto-renewal chain:**
Se `IS_FIRST_REN` está vazio e o DCD mostra `endDate` anterior ao `PREV_CONTR_ITEM_END_DATE` do Harmony → o contrato auto-renovou anualmente sem criar novo DCD case. Usar `PREV_CONTR_ITEM_END_DATE` do Harmony como data do predecessor real para o IPCA.

---

## FASE 3 — Baixar PDFs (um por contrato único)

Para cada contrato no mapa:

```
dcd_contract_documents(caseId)
```
→ identificar documento com `categoryDesc = "Contract Documents"`.

```
dcd_download_contract(caseId)
```

Se retornar `downloaded: []`:
- Inspecionar lista retornada em `skipped`
- Usar `documentId` explícito: `dcd_download_contract(caseId, documentId: "...")`

---

## FASE 4 — Ler os PDFs

```bash
pdftotext -layout "<caminho_do_pdf>" -
```

Extrair por contrato:

### 4.1 Dados de produto (Anexo 1 / Order Form)
- Produtos, quantidades, valores por período de serviço
- OBV = valor anual (se prazo < 12 meses: `OBV = (total / meses) × 12`)
- Rampa (ramp-up): valores crescentes por período → usar **valor do último período** como OBV de referência
- Créditos ("Credit this Order Form"): não confundir com produto de receita

### 4.2 Renewal Type (fonte primária = texto do contrato)

| Texto no PDF | Renewal Type |
|---|---|
| "renovará automaticamente" / "renovados automaticamente" / "auto-renew" | Auto Renewal |
| "A SAP e o Cliente podem concordar em renovar..." | Active Renewal |

> O campo Auto Renewal no CMS é referência secundária — o PDF é sempre a fonte primária.

### 4.3 Uplift / Reajuste — lógica por país

**Identificar o país da conta no Harmony** (campo `ACCNT_PE_PLN_GROUP` ou `COUNTRY` das PartiesInvolved) antes de decidir a metodologia.

**Brasil:**
- Procurar cláusula §5.4 (ou §6.4, §3.2): define aniversário, indexador e forma de cálculo
- IPCA/CPI mencionado → `contrUpliftType = "7"` (CPI Per Annum)
- Sem cláusula de reajuste → `contrUpliftType = "1"` (No Increase), Uplift % = 0
- OBV = BRL 0,00 (entitlement): CPI Per Annum, Uplift % = 0
- Calcular via API BCB série 433 (metodologia cumulativa)

**América Latina (não-Brasil), Europa e outros mercados:**
- Taxa fixa contratual de 3,3% — **NÃO** calcular via API BCB
- Verificar no contrato: taxa flat/fixa mencionada → `contrUpliftType = "6"` (Flat Per Annum, key 6)
- Índice de preços local mencionado → `contrUpliftType = "7"` (CPI Per Annum, key 7)
- Sem cláusula de reajuste → `contrUpliftType = "1"` (No Increase)

**Tabela de keys de Uplift Type:**
| Key | Tipo | Uso |
|---|---|---|
| `"6"` | Flat Per Annum | LATAM/outros — taxa fixa (padrão 3,3%) |
| `"7"` | CPI Per Annum | Brasil — indexado IPCA |
| `"1"` | No increase language | Sem cláusula de reajuste |

### 4.4 GTC Version
- Rodapé: `ptBR.v.X-YYYY` → mês = X, ano = YYYY, GTC Date = `01/0X/YYYY`
- **SAP Store digital orders:** sem rodapé → GTC Date = N/A

### 4.5 Parceiro
- Seção §7.3 ou equivalente — verificar se registrado no Harmony

### 4.6 EEI (Early Ending Item)
- Item com product end date anterior ao contract end date
- Identificar datas corretas para cálculo IPCA (usar datas do item, não do contrato pai)

Registrar por contrato: `{ obv, gtcVersion, renewalType, hasIPCA, startDate, endDate }`

---

## FASE 5 — Validação de OBV

Para cada item no Harmony, comparar OBV com Anexo 1 do contrato:

| Situação | Ação |
|---|---|
| OBV Harmony = OBV PDF | Validado — sem IPCA aplicado |
| OBV Harmony > OBV PDF (0–15%) | IPCA automático plausível — registrar delta |
| OBV Harmony > OBV PDF (> 15%) | Flag de alerta — investigar |
| OBV Harmony < OBV PDF | Alerta crítico — linha ou produto faltante |
| OBV PDF = BRL 0,00 | Estrutural (entitlement) — validar formalmente mesmo assim |
| PDF indisponível (D4Sign only) | Usar DCD AACV como referência; documentar limitação |

---

## FASE 6 — Análise IPCA por contrato

Cálculo **independente** para cada contrato predecessor — retroativo desde o início do contrato.

### 6.1 Lógica diferenciada por tipo

| Tipo | IPCA Faltante | Fórmula OBV Alvo |
|---|---|---|
| **Contrato Inicial** | IPCA total acumulado − IPCA já aplicado | `OBV_harmony × (1 + IPCA_Faltante)` |
| **Aditivo** | IPCA total do período do Aditivo (sem dedução) | `OBV_harmony × (1 + IPCA_total_período)` |

**IPCA já aplicado** (Contrato Inicial):
> Delta % entre OBV do PDF (Anexo 1, último período da rampa) e OBV atual no Harmony.

### 6.2 Datas para o cálculo — regra EEI

Para itens com `RENEWAL_CONTRACT_TYPE = 'EEI'`: usar datas do **item** (`CONTR_START_DATE` / `CONTR_END_DATE`).
Para todos os demais: usar datas do contrato DCD mapeado na Fase 2 (ou `PREV_CONTR_ITEM_END_DATE` do Harmony para auto-renewal chains).

### 6.3 Cálculo via API BCB (série 433)

```
Janela = (Start Date − 6 meses) → (End Date − 6 meses)
```

```bash
curl "https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados?formato=json&dataInicial=DD/MM/YYYY&dataFinal=DD/MM/YYYY"
```

Calcular produto cumulativo: `((1+m1) × (1+m2) × ... × (1+mN)) − 1`

Meses não publicados pelo IBGE → sinalizar como "pending IBGE publication" e usar valor parcial.

### 6.4 OBV Alvo por contrato

```
OBV Alvo = OBV_harmony × (1 + IPCA_Faltante)
```

Tabela consolidada esperada:
```
Contrato Inicial:
  IPCA total: 31.36% | Já aplicado: 9.52% | A sugerir: 21.84%
  OBV Harmony: BRL 249.900  →  OBV Alvo: BRL 304.469

Aditivo 1:
  IPCA total período: 12.51% | A sugerir: 12.51%
  OBV Harmony: BRL 112.787  →  OBV Alvo: BRL 126.897

TOTAL OBV Harmony: BRL 362.687  |  TOTAL OBV Alvo: BRL 431.366
```

### 6.5 Risk Retention Lever

| Situação | Key |
|---|---|
| `RENEWAL_CONTRACT_TYPE = "EEI"` (opp ou item) | `NON` |
| Business Model = Cloud Choice Flex + risco de churn ativo | `CMI` |
| Auto Renewal sem risco de churn / entitlement zero-cost | `NON` |
| Demais casos | `NON` |

### 6.6 GTC Date

Rodapé do PDF: `ptBR.v.X-YYYY` → passar como `"YYYY-0X-01"` para `harmony_set_renewal_execution`.
SAP Store digital orders: sem rodapé → **não preencher** o campo GTC Date.

### 6.7 GTC Deviations — identificar ANTES de chamar harmony_set_renewal_execution

Exemplos de deviations obrigatórias:
- **Active Renewal** (não Auto) — sempre deviation
- Pagamento não-padrão (trimestral Z102, bimestral, etc.)
- Mais de um pagador
- Créditos ou cláusulas incomuns negociadas com Legal

**Redlines = cópia idêntica de GTC Deviations.**

### 6.8 Verificação de editabilidade

Se `IS_EDITABLE = false` OU `STATUS = E0002/E0005` → não chamar nenhum `harmony_set_*`. Gerar relatório de análise normalmente.

---

## FASE 7 — Preencher Harmony (ordem obrigatória)

**Pré-condição:** `IS_EDITABLE = true` E `STATUS ≠ E0002/E0005`.

### 7.0 Título (naming convention)

Se componentes ausentes detectados na Fase 1.3:
```
harmony_set_opp_description(opp_id, text: "<título corrigido>")
```

### 7.1 Close Date

- **Se Active Renewal → não alterar Close Date.**
- **Se Auto Renewal:**

1. Calcular: `expectedCloseDate = Prior Order End Date − 30 dias`
2. Comparar com `EXPECT_END` atual
3. Se diferente:
   ```
   harmony_set_close_date(opp_id, date: "YYYY-MM-DD")
   ```
   - **Nunca pular esta chamada** — `CLOSE_DATE_EDITABLE: false` é apenas estado da UI; o MCP bypassa e grava mesmo assim
   - `ok: true` (mesmo com `wasEditable: false`) → atualizado com sucesso
   - `ok: false` → flag: "Close Date bloqueado — revisão manual necessária"

### 7.2 Risk Retention Lever

```
harmony_set_renewal_risk(opp_id, riskRetentionLever: "NON")  # ou "CMI"
```

### 7.3 Campos de execução

```
harmony_set_renewal_execution(opp_id,
  obvValidated:      "Y",
  gtcDate:           "YYYY-MM-DD",    # do rodapé ptBR.v.X-YYYY; omitir se SAP Store
  contrUpliftType:   "7",             # Brasil IPCA: "7" CPI Per Annum | LATAM/outros: "6" Flat Per Annum | sem reajuste: "1" No Increase
  negUpliftLang:     "Y",             # Y se IPCA/tributos mencionados no contrato
  contrUpliftPc:     "X.XX",         # IPCA a sugerir (parcial se meses pendentes IBGE)
  gtcDeviationsFlag: "Y" ou "N"
)
```

### 7.4 Notas

```
harmony_set_renewal_execution_notes(opp_id,
  obvValidatedNote:   "<ZRE1 — template seção 7.5>",
  renewalClosePlan:   "<ZRE4 — template seção 7.5>",
  upliftRemarks:      "<ZRE6 — template seção 7.5>",
  perAnnumLanguage:   "<ZRE8 — evidência cláusula IPCA>",    # se aplicável
  internalRoadblocks: "<ZRED — bloqueadores reais>",          # somente se houver
  gtcDeviationsText:  "<ZRE3 — texto das deviations>",        # somente se GTC Dev = Y
  redlines:           "<ZREE — cópia idêntica de ZRE3>"       # somente se GTC Dev = Y
)
```

**NUNCA usar `harmony_set_risk_notes`** — TDIDs diferentes.

### 7.5 Templates de nota

**OBV Validated (ZRE1) — PDF disponível:**
```
- [N]-month contract | [Auto/Active Renewal]
- Contract OBV: BRL [valor] → Harmony OBV: BRL [valor] ([delta%])
- Delta: [motivo conciso, ex: IPCA applied over 2 renewal cycles]
[Scrubbot, DD/MM/YYYY]
```

**OBV Validated (ZRE1) — PDF indisponível (D4Sign only):**
```
- [N]-month contract | [Auto/Active Renewal]
- Contract AACV (DCD): BRL [valor] → Harmony OBV: BRL [valor] ([delta%])
- GTC version and uplift clause could not be confirmed (D4Sign certificate only)
[Scrubbot, DD/MM/YYYY]
```

**Renewal Close Plan (ZRE4):**
```
- CRE: [nome] | AO: [nome]
- [Auto/Active Renewal] — [plano conciso ou "standard close expected"]
[Scrubbot, DD/MM/YYYY]
```

**Uplift % Remarks (ZRE6) — contrato único:**
```
- Cumulative IPCA available: X.XX% ([N]/12 months published)
- Already applied: X.XX%
- Suggested: X.XX% [partial — pending IBGE: Mmm/YYYY–Mmm/YYYY — update once published]
[Scrubbot, DD/MM/YYYY]
```

**Uplift % Remarks (ZRE6) — multi-contrato:**
```
Contrato Inicial:
- Cumulative IPCA available: X.XX% ([N]/12 months published)
- Already applied: X.XX%
- Suggested: X.XX% [partial — pending IBGE: Mmm/YYYY–Mmm/YYYY — update once published]

Aditivo 1:
- Total cumulative IPCA: X.XX%
- Suggested: X.XX%
[Scrubbot, DD/MM/YYYY]
```

**Per Annum Language (ZRE8):**
```
- [Citação breve da cláusula no PDF que confirma linguagem CPI/IPCA]
[Scrubbot, DD/MM/YYYY]
```

### 7.6 Regras absolutas das notas

- Inglês, bullet points, aditivo (nunca sobrescrever)
- Assinatura: `[Scrubbot, DD/MM/YYYY]`

**NUNCA incluir nas notas:**
- IDs internos: CMS case ID, order numbers, item numbers (item 40, items 50/60)
- Date ranges de contratos ou itens (ex: 2025-06-24 to 2026-06-23)
- Referência "BCB série 433", janela de lookback IPCA, meses individuais com %
- Sub-itens de faturamento ou breakdown de percentuais (Cloud 90% / Service 10%)
- Componentes de billing (ex: "Items 50 and 60 are billing sub-components of item 40")
- Mecânica de auto-renewal: prazo de aviso, deadline de cancelamento, datas de vencimento
- Ausência de riscos ou problemas
- Segmento do cliente
- Lista de produtos/soluções (salvo item faltante)

### 7.7 Ações manuais (não automatizáveis via MCP — registrar no relatório)

- **Renewal Type:** não editável via MCP — alterar manualmente na UI Harmony
- **Incremental Increase Block por item:** definir `Increase Type` e `Increase %` para cada linha na UI Harmony

---

## FASE 8 — Verificação

Após `harmony_set_renewal_execution_notes` retornar `changedNotes` preenchido:
- Confirmar via `harmony_read_renewal_execution` se os campos foram gravados
- O save é automático no MCP headless

---

## FASE 9 — Relatório (gerar no chat — não abrir Teams)

```
SCRUBBING CONCLUÍDO — OPP [opp_id]
[DD/MM/YYYY]

RESUMO
• Cliente: [nome]
• Status OPP: [status — se E0002/E0005: "análise de referência apenas"]
• Renewal Type: [Auto / Active]
• Vencimento (Prior Order End Date): [data]
• Close Date atual: [data] | Esperado (D-30): [data] | [✓ correto / ⚠ diferença N dias]
• D- até vencimento: [N dias]
• Contratos predecessores: [N] ([Inicial + Aditivo 1 + ...])

OBV DA OPORTUNIDADE
• OBV atual (Harmony): BRL [total]
• OBV alvo para quote (+IPCA): BRL [total alvo]
• IPCA médio sugerido: ~X.XX%

CAMPOS PREENCHIDOS NO HARMONY
• Título: [corrigido para "[novo]" / já correto / flag: motivo]
• Risk Retention Lever: [NON / CMI]
• OBV Validated: Yes
• Renewal Close Plan: CRE [nome] | AO [nome]
• Uplift % Remarks: IPCA por contrato (ver nota no Harmony)
• GTC Deviations: [resumo ou —]
• Uplift Type: [CPI Per Annum / No Increase]
• GTC Date: [DD/MM/YYYY ou N/A — SAP Store]
• Uplift %: [valor] [parcial — pending IBGE: meses se aplicável]
• Per Annum Language: [Y / N]

AÇÕES MANUAIS PENDENTES
• Renewal Type: alterar para [Auto/Active Renewal] na UI Harmony
• Incremental Increase Block: definir Increase Type = CPI Per Annum / Increase % = X.XX% por linha

FLAGS
• [lista ou —]

PRONTO PARA QUOTE
• OBV alvo total: BRL [valor]
• Renewal Type: [Auto / Active]
• Deviations: [Sim — resumo / Não]
```

**Para opps com múltiplos contratos, adicionar seção:**
```
ANÁLISE IPCA POR CONTRATO

Contrato Inicial ([Start]–[End]):
  IPCA total: XX.XX% | Já aplicado: XX.XX% | A sugerir: XX.XX%
  OBV Harmony: BRL [atual]  →  OBV Alvo: BRL [alvo]

Aditivo 1 ([Start]–[End]):
  IPCA total período: XX.XX% | A sugerir: XX.XX%
  OBV Harmony: BRL [atual]  →  OBV Alvo: BRL [alvo]
```

---

## Flags críticas (registrar e continuar — NÃO parar o scrubbing)

- **Quote cancelada** → registrar em Internal Roadblocks, continuar
- **Quote bloqueada** → registrar causa, continuar
- **D-30 ou menos para Active Renewal** → urgência alta na nota
- **Divergência OBV > 1%** entre Harmony e PDF → registrar com delta em BRL
- **Parceiro no PDF ausente no Harmony** → flag observacional
- **PDF é apenas certificado D4Sign** → usar DCD AACV como referência
- **Meses IPCA pendentes IBGE** → valor parcial + nota ZRE6
- **PREV_CONTR_ID não localizado no DCD** → flag, continuar

---

## Checklist de conclusão

- [ ] `harmony_opp_read` — header + Items + PartiesInvolved + IS_EDITABLE verificado
- [ ] Quotes, erros e warnings verificados
- [ ] `harmony_read_renewal_execution` — estado inicial registrado
- [ ] `dcd_customer_contracts` — todos os PREV_CONTR_ID mapeados a CASE_ID
- [ ] PDF(s) baixado(s) com `dcd_download_contract`
- [ ] PDF lido: OBV Anexo 1, cláusula IPCA, rodapé GTC, renewal type, parceiro
- [ ] OBV conferido e classificado (Harmony vs PDF/DCD AACV)
- [ ] IPCA calculado por contrato via BCB (lógica diferenciada Inicial vs Aditivos)
- [ ] OBV Alvo calculado por contrato e total consolidado
- [ ] `harmony_set_opp_description` — título corrigido ou flag
- [ ] `harmony_set_renewal_risk` — Risk Retention Lever
- [ ] `harmony_set_renewal_execution` — campos preenchidos
- [ ] `harmony_set_renewal_execution_notes` — `changedNotes` preenchido
- [ ] Ações manuais listadas no relatório
- [ ] Relatório com tabela OBV Alvo gerado no chat

---

## FAQ & Gotchas

**Q: SAP Store digital order — como identificar e tratar?**
- Sem rodapé `ptBR.vX-YYYY` → GTC Date = N/A
- Não preencher o campo `gtcDate` em `harmony_set_renewal_execution`

**Q: CCFlex auto-renewal chain — DCD mostra data anterior à do Harmony?**
- Auto-renovações anuais não criam novo DCD case
- `IS_FIRST_REN` vazio = contrato já foi renovado antes
- Usar `PREV_CONTR_ITEM_END_DATE` do Harmony como data real do predecessor

**Q: PREV_CONTR_ID não tem formato padrão?**
- Paddar com zeros à esquerda até 10 dígitos: `61739562` → `0061739562`

**Q: Rampa (ramp-up) — qual OBV usar?**
- Usar **valor do último período** como OBV de referência

**Q: Billing Cycle trimestral (Z102) — é GTC Deviation?**
- Sim — faturamento não-padrão configura GTC Deviation
- Registrar em ZRE3 + cópia idêntica em ZREE

**Q: Active Renewal — sempre é GTC Deviation?**
- Sim — sempre deviation obrigatória
- ZRE3: `- This is an active-renewal contract.` → copiar identicamente para ZREE

**Q: OBV = BRL 0,00 — precisa validar?**
- Sim — pode ser entitlement estrutural
- Uplift Type = CPI Per Annum, Uplift % = 0; validar com nota em ZRE1

**Q: EEI em Harmony?**
- `Risk Retention Lever = NON`
- IPCA: usar datas do item, não do contrato pai

**Q: IPCA parcial — o que preencher?**
- `contrUpliftPc`: valor parcial disponível
- ZRE6: documentar meses disponíveis + `"— field should be updated once IBGE publishes [Mmm/YYYY–Mmm/YYYY]"`

**Q: Co-Termed vs Non-Co-Termed?**
- **Co-Termed**: todos os itens com mesma data de vencimento
- **Non-Co-Termed**: itens com datas diferentes, cada um renova na sua própria data
