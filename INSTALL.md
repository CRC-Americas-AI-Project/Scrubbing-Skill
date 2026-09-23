# SAP Scrubbing MCP — Guia de Instalação

## O que é

O SAP Scrubbing MCP é um servidor local que conecta o Joule Desktop às APIs do Harmony e DCD, permitindo o scrubbing de oportunidades SAP diretamente do Joule.

---

## Pré-requisitos

| Requisito | Versão | Download |
|---|---|---|
| **Node.js** | 20 ou superior | https://nodejs.org |
| **Git** | qualquer | https://git-scm.com |
| **Chrome ou Edge** | qualquer | (geralmente já instalado) |

> A máquina precisa ter acesso à rede SAP (VPN corporativa ou rede do escritório).

---

## Instalação no Mac

Abra o **Terminal** e execute:

```bash
curl -fsSL https://raw.githubusercontent.com/CRC-Americas-AI-Project/Scrubbing-Skill/main/install.sh | bash
```

Ou, se já tiver o repositório clonado:

```bash
bash install.sh
```

---

## Instalação no Windows

1. Abra o **PowerShell** como administrador
2. Execute:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install.ps1
```

Ou clique com o botão direito em `install.ps1` → **"Executar com o PowerShell"**.

---

## Como iniciar o servidor

### Mac
```bash
cd ~/.sap-scrubbing
npm run start:unified
```

### Windows
Clique duplo em **"SAP Scrubbing MCP.bat"** na sua Mesa de Trabalho.

---

## Configurar o Joule Desktop

No Joule Desktop → Settings → Extensions → Add Connector:

| Campo | Valor |
|---|---|
| **Name** | `SAP Scrubbing MCP` |
| **URL** | `http://localhost:8812/mcp` |
| **Auth** | None |
| **Header** | `X-User-Id: I749420` *(substitua pelo seu i-number)* |

---

## Primeira utilização

Na primeira vez que o Joule chamar uma ferramenta (ex: `harmony_whoami`), o servidor vai:

1. Abrir um browser headless automaticamente
2. Fazer login no SAP via SSO corporativo (Kerberos — sem precisar de senha)
3. Salvar os cookies em `~/.sap-mcp/auth.json`

Nas próximas **24 horas**, o servidor usa os cookies salvos sem precisar abrir o browser novamente.

---

## Atualizar

Para atualizar para a versão mais recente, execute o script de instalação novamente:

```bash
# Mac
bash ~/.sap-scrubbing/install.sh

# Windows
.\install.ps1
```

---

## Solução de problemas

| Problema | Solução |
|---|---|
| `Node.js não encontrado` | Instale em https://nodejs.org (versão 20+) |
| `Erro de autenticação SAP` | Verifique se está na rede SAP ou com VPN ativa |
| `Porta 8812 em uso` | Execute `npm run start:unified` — o script fecha processos anteriores automaticamente |
| `Chrome não encontrado` | Instale o Google Chrome ou Microsoft Edge |
