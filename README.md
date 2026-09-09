# SAP Scrubbing MCP

Servidores MCP que conectam o **SAP Harmony** (CPQ / oportunidades) e o **SAP DCD** (contratos assinados) ao **Joule Desktop** e ao **Claude Code**, expondo uma Skill de Scrubbing de oportunidades 100% headless.

---

## O que é

A **Skill de Scrubbing** (`scrubbing2.0`) orquestra automaticamente a análise de uma oportunidade SAP:

1. Lê a oportunidade no **Harmony** (CRE, AO, itens, OBV, tipo de renovação)
2. Localiza o **contrato predecessor** no DCD pelo `ORDER_ID`
3. Baixa e lê o **PDF do contrato** (GTC version, IPCA, Annexo 1)
4. Valida o **OBV** (Harmony vs PDF, detecta IPCA automático)
5. Preenche os campos de **RenewalExecution** e **notas de risco** no Harmony

Tudo sem abrir browser, sem Playwright, sem intervenção manual.

---

## Pré-requisitos

| Requisito | Versão mínima |
|---|---|
| Node.js | ≥ 20.0.0 |
| npm | ≥ 10.0.0 |
| Sistema operacional | macOS / Linux |
| Acesso à rede | SAP Corporate Network ou VPN ativa |
| Conta SAP | Com acesso ao Harmony (Callidus CPQ) e ao DCD Cockpit |

> **Windows:** use WSL2 (Ubuntu). O script `start-scrubbing.sh` não roda em PowerShell/CMD nativamente.

---

## Instalação

```bash
# 1. Clonar o repositório
git clone https://github.com/CRC-Americas-AI-Project/sap-scrubbing.git
cd sap-scrubbing

# 2. Instalar dependências
npm install

# 3. Compilar os pacotes compartilhados (TypeScript → JavaScript)
npm run build
```

O `npm run build` compila na ordem correta: `mcp-utils` → `mcp-logger` → `sap-auth`. Os servidores Harmony e DCD são ESM puro — não precisam de compilação.

---

## Autenticação

O projeto usa **SSO headless via Puppeteer**. Não há configuração manual de tokens, senhas ou variáveis de ambiente.

**Como funciona:**

1. Na **primeira chamada** a qualquer ferramenta, o `sap-auth` detecta que não há sessão salva
2. Abre um browser Chromium **headless** e navega até a URL de entrada do sistema SAP
3. Se você já estiver logado no browser do sistema (SSO corporativo ativo), o cookie é capturado automaticamente
4. O cookie é salvo em `~/.sap-mcp/auth.json` com permissão `0600` (só leitura do usuário)
5. Nas chamadas seguintes, o cookie é reutilizado por até **23h30**

> **Primeira vez:** pode levar 10–20 segundos enquanto o browser headless inicializa e captura o cookie. Chamadas subsequentes são imediatas.

> **Sem VPN/rede SAP:** a autenticação vai falhar silenciosamente. Certifique-se de estar na rede SAP antes de iniciar.

---

## Iniciar os servidores

```bash
# Opção 1: subir Harmony + DCD juntos (recomendado)
./start-scrubbing.sh

# Opção 2: via npm
npm run start:scrubbing

# Opção 3: servidores individualmente
npm run start:harmony   # apenas Harmony (porta 8810)
npm run start:dcd       # apenas DCD (porta 8811)
```

Saída esperada:

```
╔══════════════════════════════════════════╗
║   SAP Harmony MCP Server (HTTP)          ║
║   URL: http://localhost:8810/mcp         ║
╚══════════════════════════════════════════╝
╔══════════════════════════════════════════╗
║   SAP DCD MCP Server (HTTP)              ║
║   URL: http://localhost:8811/mcp         ║
╚══════════════════════════════════════════╝

╔══════════════════════════════════════════════════════╗
║        SAP Scrubbing MCP Servers — ativos            ║
║  Harmony  →  http://localhost:8810/mcp               ║
║  DCD      →  http://localhost:8811/mcp               ║
║  Pressione Ctrl+C para encerrar.                     ║
╚══════════════════════════════════════════════════════╝
```

Para encerrar: **Ctrl+C** — derruba ambos os servidores.

---

## Configurar no Joule Desktop

Com os servidores rodando, adicione os dois MCPs no Joule Desktop:

1. Abra o **Joule Desktop** → Settings → MCP Servers (ou equivalente na sua versão)
2. Clique em **Add MCP Server**
3. Adicione o primeiro servidor:
   - **Name:** `SAP Harmony`
   - **URL:** `http://localhost:8810/mcp`
   - **Transport:** Streamable HTTP
4. Clique em **Add MCP Server** novamente e adicione o segundo:
   - **Name:** `SAP DCD`
   - **URL:** `http://localhost:8811/mcp`
   - **Transport:** Streamable HTTP
5. Salve e recarregue o Joule Desktop

> Os servidores precisam estar rodando (`./start-scrubbing.sh`) antes de o Joule Desktop conectar.

---

## Configurar no Claude Code (alternativa ao Joule)

Para usar diretamente no Claude Code via **stdio** (sem servidor HTTP), adicione ao `~/.claude.json`:

```json
{
  "mcpServers": {
    "sap-harmony": {
      "command": "node",
      "args": ["/caminho/para/sap-scrubbing/packages/servers/sap-harmony-mcp/src/mcp-server.mjs"],
      "type": "stdio"
    },
    "sap-dcd": {
      "command": "node",
      "args": ["/caminho/para/sap-scrubbing/packages/servers/sap-dcd-mcp/src/mcp-server.mjs"],
      "type": "stdio"
    }
  }
}
```

Substitua `/caminho/para/sap-scrubbing` pelo caminho absoluto onde você clonou o repositório.

Após editar o arquivo, **reinicie o Claude Code** para carregar os novos servidores.

---

## Usar a Skill de Scrubbing

A Skill está em `.claude/commands/scrubbing2.0.md`. Ela é uma instrução de orquestração para o agente — não é código executável, mas um roteiro que o Claude segue ao processar uma oportunidade.

### No Joule Desktop

Digite no chat do Joule:

```
/scrubbing2.0 <OPP_ID>
```

Exemplo:

```
/scrubbing2.0 306445317
```

### No Claude Code

```
/scrubbing2.0 306445317
```

ou

```
Faça o scrubbing da oportunidade 306445317
```

### O que acontece

| Fase | Ação | Ferramenta |
|---|---|---|
| 1 | Lê a OPP: header, itens, parties | `harmony_opp_read` |
| 1 | Verifica quote e erros ativos | `harmony_opp_list_quotes`, `harmony_messages_set` |
| 1 | Lê estado atual de RenewalExecution | `harmony_read_renewal_execution` |
| 2 | Busca contrato predecessor no DCD | `dcd_customer_contracts` |
| 2 | Lista documentos disponíveis | `dcd_contract_documents` |
| 2 | Baixa PDF do contrato | `dcd_download_contract` |
| 3 | Lê e analisa o PDF | `Read` (tool nativa do Claude) |
| 4 | Valida OBV (Harmony vs PDF) | — análise interna — |
| 5 | Decide Risk Lever, Uplift Type, GTC Date | — análise interna — |
| 6 | Salva Risk Retention Lever | `harmony_set_renewal_risk` |
| 6 | Salva RenewalExecution (OBV, GTC Date, etc.) | `harmony_set_renewal_execution` |
| 6 | Salva notas (OBV, Executive Summary, IPCA) | `harmony_set_risk_notes` |

---

## Ferramentas disponíveis

### Harmony MCP — `http://localhost:8810/mcp` (35 ferramentas)

| Ferramenta | Descrição |
|---|---|
| `harmony_whoami` | Verifica autenticação e retorna usuário logado |
| `harmony_opp_read` | Lê oportunidade completa (header + itens + parties) |
| `harmony_opp_list_quotes` | Lista quotes de uma oportunidade |
| `harmony_messages_set` | Erros e warnings ativos da OPP |
| `harmony_read_renewal_execution` | Lê campos de RenewalExecution |
| `harmony_set_renewal_execution` | Preenche campos de RenewalExecution |
| `harmony_set_renewal_risk` | Define Risk Retention Lever e códigos de risco |
| `harmony_set_risk_notes` | Escreve notas de OBV, Executive Summary, IPCA |
| `harmony_deals_list` | Lista oportunidades com filtros (owner, quarter, status) |
| `harmony_cpq2_read_quote` | Lê quote CPQ 2.0 pelo ID curto |
| `harmony_cpq2_read_items` | Lê itens de quote CPQ 2.0 com pricing |
| `harmony_cpq2_list_quotes` | Lista quotes CPQ 2.0 de uma OPP |
| `harmony_cpq2_read_table` | Lê QuoteTable específica (Deal_Health, T4CRights, etc.) |
| *(+22 ferramentas CPQ 1.0 e utilitários)* | |

### DCD MCP — `http://localhost:8811/mcp` (6 ferramentas)

| Ferramenta | Descrição |
|---|---|
| `dcd_whoami` | Verifica acesso ao DCD Cockpit |
| `dcd_search` | Busca cliente por nome no DCD |
| `dcd_customer_contracts` | Lista contratos de um cliente pelo ERP ID |
| `dcd_contract_documents` | Lista documentos PDF disponíveis de um case |
| `dcd_download_contract` | Baixa PDF(s) do contrato assinado |
| `dcd_contract_clauses` | Lê ~130 campos de cláusulas do contrato |

---

## Troubleshooting

### `Auth failed` ou timeout na primeira chamada
- Verifique se está conectado à rede SAP (VPN ativa)
- Abra manualmente a URL `https://sapit-sales-prod-budgie.launchpad.cfapps.eu10.hana.ondemand.com` no browser e confirme que consegue acessar
- Delete `~/.sap-mcp/auth.json` e tente novamente

### `EADDRINUSE: address already in use :8810`
- Algum processo anterior ficou preso na porta: `lsof -ti :8810 | xargs kill`
- O `start-scrubbing.sh` já faz isso automaticamente; se falhar, faça manualmente

### DCD retorna `HTTP 404` nas chamadas
- A URL base do DCD pode ter mudado (o GUID do managed-approuter pode rodar após redeploy)
- Defina a variável de ambiente `DCD_BASE` com a nova URL base antes de iniciar:
  ```bash
  export DCD_BASE=https://sapit-finance-prod-eagle.launchpad.cfapps.eu10.hana.ondemand.com/NOVO-GUID.mdsdlcdcdcockpit.mdsdlcdcdcockpit
  ./start-scrubbing.sh
  ```

### `npm run build` falha
- Verifique a versão do Node.js: `node --version` (precisa ser ≥ 20)
- Tente limpar e reinstalar: `rm -rf node_modules && npm install && npm run build`
- Se o erro for em `sap-auth/dist`, verifique se o TypeScript está instalado: `npx tsc --version`

### Joule Desktop não conecta
- Confirme que os servidores estão rodando: `curl http://localhost:8810/mcp` deve retornar texto
- Verifique se o Joule Desktop está usando `http://` (não `https://`) e a porta correta
- Reinicie o Joule Desktop após adicionar os servidores

---

## Arquitetura

```
┌─────────────────────────────────────────────────────────────────┐
│                    Joule Desktop / Claude Code                  │
│                   (invoca tools via MCP protocol)               │
└──────────────────────┬──────────────────────┬───────────────────┘
                       │                      │
              POST /mcp (HTTP)       POST /mcp (HTTP)
              Streamable HTTP        Streamable HTTP
                       │                      │
         ┌─────────────▼──────────┐  ┌────────▼────────────────┐
         │  mcp-server-http.mjs   │  │  mcp-server-http.mjs    │
         │  Harmony (porta 8810)  │  │  DCD (porta 8811)       │
         │  [StreamableHTTP proxy]│  │  [StreamableHTTP proxy] │
         └─────────────┬──────────┘  └────────┬────────────────┘
                  stdio pipe              stdio pipe
         ┌─────────────▼──────────┐  ┌────────▼────────────────┐
         │   mcp-server.mjs       │  │  mcp-server.mjs         │
         │   Harmony (stdio MCP)  │  │  DCD (stdio MCP)        │
         │   harmony-client.mjs   │  │  dcd-client.mjs         │
         └─────────────┬──────────┘  └────────┬────────────────┘
                       │                      │
               ┌───────▼──────────────────────▼──────┐
               │         sap-auth (shared)            │
               │  SSO headless via Puppeteer          │
               │  Cookie cache: ~/.sap-mcp/auth.json  │
               └───────┬──────────────────────┬───────┘
                       │                      │
         ┌─────────────▼──────────┐  ┌────────▼────────────────┐
         │  SAP Harmony (Callidus)│  │  SAP DCD Cockpit        │
         │  OData zharmony_srv    │  │  OData ZDCD_SRV         │
         │  sapit-sales-prod-*    │  │  sapit-finance-prod-*   │
         └────────────────────────┘  └─────────────────────────┘
```

---

## Estrutura do repositório

```
sap-scrubbing/
├── start-scrubbing.sh              # Launcher: sobe Harmony + DCD
├── package.json                    # Monorepo workspaces npm
├── .claude/
│   └── commands/
│       └── scrubbing2.0.md         # Skill de orquestração do Scrubbing
├── packages/
│   ├── shared/
│   │   ├── sap-auth/               # Autenticação SSO headless (TypeScript)
│   │   ├── mcp-logger/             # Logger compartilhado
│   │   └── mcp-utils/              # Utilitários MCP compartilhados
│   └── servers/
│       ├── sap-harmony-mcp/
│       │   └── src/
│       │       ├── mcp-server.mjs        # Servidor stdio (Claude Code)
│       │       ├── mcp-server-http.mjs   # Servidor HTTP (Joule Desktop)
│       │       ├── harmony-client.mjs    # Cliente API Harmony
│       │       └── ...
│       └── sap-dcd-mcp/
│           └── src/
│               ├── mcp-server.mjs        # Servidor stdio (Claude Code)
│               ├── mcp-server-http.mjs   # Servidor HTTP (Joule Desktop)
│               ├── dcd-client.mjs        # Cliente API DCD
│               └── ...
```

---

## Contribuição

Este repositório é mantido pelo time **CRC Americas AI Project**. Para reportar problemas ou sugerir melhorias, abra uma issue em `https://github.com/CRC-Americas-AI-Project/sap-scrubbing`.
