---
name: "scrubbing2.0"
version: "2.0"
description: "Executa scrubbing completo de uma oportunidade SAP: lê Harmony via MCP, baixa e analisa o contrato PDF via DCD MCP, valida OBV e preenche campos no Harmony. 100% headless via harmony-mcp e dcd-mcp, sem Playwright e sem envio para Teams. Use quando o usuário disser scrubbing, scrub, analisar oportunidade ou fornecer um OPP_ID."
author: "SAP Renewals Team"
language: "pt-BR"
argument-hint: <OPP_ID>
arguments: [opp_id]
allowed-tools: >
  Bash
  mcp__sap-harmony__harmony_opp_read
  mcp__sap-harmony__harmony_opp_list_quotes
  mcp__sap-harmony__harmony_messages_set
  mcp__sap-harmony__harmony_read_renewal_execution
  mcp__sap-harmony__harmony_set_renewal_execution
  mcp__sap-harmony__harmony_set_risk_notes
  mcp__sap-harmony__harmony_set_renewal_risk
  mcp__sap-harmony__harmony_odata_function
  mcp__sap-dcd__dcd_customer_contracts
  mcp__sap-dcd__dcd_contract_documents
  mcp__sap-dcd__dcd_download_contract
  WebFetch
user-invocable: true
---

# Skill: Scrubbing de Oportunidade SAP 2.0 (Headless)

## Contexto e objetivo

Você executa um scrubbing completo da oportunidade `$opp_id` sem Playwright.
Todos os dados são obtidos via MCP do Harmony e DCD. O objetivo é:

1. Ler a oportunidade e o contrato predecessor (Harmony → DCD → PDF)
2. Comparar dados e identificar divergências
3. Preencher campos no Harmony (RenewalExecution + Notes + Risk)

## Regras operacionais

- **Quote cancelada não para o scrubbing.** Registrar como flag crítica e continuar.
- **Auto Renewal vs Active Renewal:** fonte primária é o PDF (cláusula SERVIÇOS CLOUD).
  "renovados automaticamente" = Auto. "A SAP e o Cliente podem concordar em renovar..." = Active.
- **Renewal Close Plan:** incluir nome do CRE (owner da OPP) **e** do AO/AE (PartiesInvolved roles ZOZOPA01/ZOZOCREX).
- **GTC Date:** derivar do rodapé do PDF (`ptBR.v.X-YYYY` → dia 1 / mês X / ano YYYY). Passar como `"YYYY-MM-DD"` para `harmony_set_renewal_execution`.
- **Redlines = cópia idêntica de GTC Deviations** — sempre sincronizar os dois campos de nota.
- **Notas:** inglês, bullet points, aditivo (nunca sobrescrever). Data no rodapé: `[Note added by Claude AI agent, DD/MM/YYYY]`.

---

## Pré-requisito: verificar argumento

Se invocado sem argumento, perguntar:
> "Qual é o OPP_ID que você quer scrubbing?"

---

## FASE 1 — Ler Harmony

### 1.1 Dados da oportunidade

Chamar `harmony_opp_read` com `expand: "PartiesInvolved,Items"`.

Extrair obrigatoriamente:

| Campo OData | Uso |
|---|---|
| `OPPT_ID` | Identificador |
| `ACCOUNT_NAME` / `ACCOUNT_ERP_ID` | Cliente / ERP para DCD |
| `OWNER_NAME` | CRE |
| `DESCRIPTION` | Nome do deal |
| `STATUS` / `IS_EDITABLE` | Verificar se editável |
| `CLOUD_REVENUE` / `CURRENCY` | Renewal Forecast Amount |
| `EXPECT_END` | Close Date — calcular D- |
| `RENEWAL_CONTRACT_TYPE` | EEI se `"EEI"`, senão vazio |
| `RENEWAL_TYPE` | Auto (`"AU"`) ou Active (`"A"`) |
| `ORDER_ID` | Contrato de origem → DCD |
| `INCREASE` | Uplift % atual no Harmony |
| `CPQ_QUOTE` / `QUOTE_STATUS` | Quote e status |
| `Items[].PRODUCT_DESCR` | Produtos |
| `Items[].ORDER_BASE_VALUE` | OBV de cada item |
| `Items[].EXPECTED_VALUE` | Renewal Forecast por item |
| `Items[].PREV_CONTR_ID` | Predecessor para DCD |
| `Items[].CONTR_START_DATE` / `CONTR_END_DATE` | Datas |
| `Items[].UPLIFT` | Uplift % |
| `PartiesInvolved` | AO = role `ZOZOPA01`, CRE = role `ZOZOCREX` |

### 1.2 Quotes e mensagens

- `harmony_opp_list_quotes` → registrar Quote Status
- `harmony_messages_set(type: "E")` → erros ativos (flags críticas)
- `harmony_messages_set(type: "W")` → warnings

### 1.3 Estado atual de RenewalExecution

`harmony_read_renewal_execution` → anotar o que já está preenchido.

---

## FASE 2 — Localizar contrato predecessor via DCD

### 2.1 Buscar contratos do cliente

`dcd_customer_contracts(ACCOUNT_ERP_ID)` → localizar case com `SALES_DOC_ID` igual ao `ORDER_ID` (left-padded 10 dígitos). Se múltiplos cases, preferir `SIGNATURE_DATE` mais recente.

Anotar: `CASE_ID`, `DEAL_TYPE`, `DEAL_DESCRIPTION`, `CONTRACT_START_DATE`, `CONTRACT_END_DATE`, `AACV`.

### 2.2 Baixar documentos

`dcd_contract_documents(caseId)` → identificar PDFs do tipo `"Contract Documents"`.

`dcd_download_contract(caseId, outDir: "~/Downloads/scrubbing-<oppId>")` → baixar todos.

---

## FASE 3 — Ler o PDF do contrato

`Read` no arquivo "Contrato…" baixado (preferir sobre Summary e BookingInfoSheet).

### 3.1 Extrair obrigatoriamente

| O que | Onde no PDF |
|---|---|
| Rodapé GTC version | `ptBR.v.X-YYYY` → GTC Date = `YYYY-0X-01` |
| Cláusula IPCA/uplift | §6.4 ou equivalente — aniversário e indexador |
| Renovação automática ou ativa | §3.2.2 ou equivalente |
| Parceiro | §7.3 ou seção de envolvimento |
| Produtos, quantidades e valores | Anexo 1 — Serviço / Métrica / Limitação / Valor Líquido Anual |
| Datas de cada item | Anexo 1 |
| OBV do contrato | Valor Líquido Anual do item principal |
| Condições de pagamento | §4 — identificar desvios do padrão |

---

## FASE 4 — Validação de OBV

### 4.1 Comparar OBV Harmony vs PDF

| Situação | Ação |
|---|---|
| OBV Harmony = OBV Contrato | Validado — sem IPCA aplicado |
| OBV Harmony > OBV Contrato (0–15%) | IPCA automático plausível — nota padrão |
| OBV Harmony > OBV Contrato (>15%) | Flag de alerta |
| OBV Harmony < OBV Contrato | Alerta — investigar item faltante |

Nota padrão para diferença plausível:
> "OBV in Harmony is above the contracted value, indicating likely automatic IPCA application by the system. The difference ([X]%) is compatible with the contract term. IPCA recalculation is not required at this stage."

---

## FASE 5 — Análise e decisões

### 5.1 Risk Retention Lever (`REVENUE_RETENTION`)
| Situação | Código |
|---|---|
| `RENEWAL_CONTRACT_TYPE = "EEI"` | `NON` |
| Cloud Choice Flex + risco de churn | `CMI` |
| Demais | `NON` |

### 5.2 Uplift Type (`CONTR_UPLF_TYP`)
| Situação | Código |
|---|---|
| Contrato com IPCA explícito | `7` (CPI Per Annum) |
| Sem cláusula de reajuste | `1` (No increase language) |

### 5.3 Per Annum Language
PDF menciona IPCA e/ou tributos → `"Y"`. Senão → `"N"`.

### 5.4 GTC Date
`ptBR.v.X-YYYY` → `"YYYY-0X-01"`. Ex: `v.4-2025` → `"2025-04-01"`.

### 5.5 GTC Deviations — preencher somente se houver:
- Pagamento diferente de anual antecipado 30 dias
- Contrato bilíngue
- Mais de um pagador
- Active Renewal (não Auto)
- Créditos ou cláusulas incomuns

**Redlines = cópia idêntica de GTC Deviations.**

---

## FASE 6 — Preencher Harmony (ordem obrigatória)

### 6.1 Risk Retention Lever

```
harmony_set_renewal_risk(oppId, { riskRetentionLever: "NON" })
```

### 6.2 Campos RenewalExecution

```
harmony_set_renewal_execution(oppId, {
  patch: {
    obvValidated:    "Y",
    gtcDate:         "YYYY-MM-DD",
    gtcDeviations:   "Y",           # ou "N"
    contrUpliftType: "7",           # ou "1"
    negUpliftLang:   "Y",           # ou "N"
    slipRisk:        "N",
  }
})
```

Verificar `ok: true`. Se `ok: false`, parar e reportar o motivo.

### 6.3 Notas (uma única chamada)

```
harmony_set_risk_notes(oppId, {
  obvValidated:      "<análise OBV e delta%>",
  executiveSummary:  "CRE: <nome>\nAO: <nome>",
  renewalRiskNote:   "<roadblocks e flags>",
  upliftRemarks:     "<análise IPCA — % e janela calculada>",
  perAnnumLanguage:  "<evidência da cláusula IPCA no PDF>",
  # gtcDeviations e redlines: incluir APENAS se houver deviations
  gtcDeviations:     "<texto das deviations>",
  redlines:          "<cópia idêntica de gtcDeviations>",
})
```

### 6.4 Formato das notas
```
- Bullet com evidência do sistema
- Bullet com cálculo ou dado relevante
[Note added by Claude AI agent, DD/MM/YYYY]
```

Regras:
- Inglês, bullet points, aditivo
- Não mencionar segmento do cliente
- Não mencionar ausência de riscos — só o que foi identificado
- Não listar produtos/soluções (salvo item faltante)

---

## FASE 7 — (removida)

---

## Checklist de conclusão

- [ ] `harmony_opp_read` — header + Items + PartiesInvolved
- [ ] Quotes e erros verificados
- [ ] Contrato predecessor localizado no DCD pelo `ORDER_ID`
- [ ] PDF baixado com `dcd_download_contract`
- [ ] PDF lido: GTC version, IPCA, Renewal Type, parceiro, Anexo 1
- [ ] OBV conferido e classificado
- [ ] `harmony_set_renewal_risk` — Risk Retention Lever (`ok: true`)
- [ ] `harmony_set_renewal_execution` — RenewalExecution (`ok: true`)
- [ ] `harmony_set_risk_notes` — todas as notas (`ok: true`)
