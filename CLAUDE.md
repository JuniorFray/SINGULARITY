# Singularity — Sistema Orquestrador IA Multiagente (v2)

Sistema Orquestrador IA de alta capacidade com arquitetura em 3 camadas, **contrato JSON determinístico de escrita em disco**, Auto-Healing estrutural, roteamento resiliente com pool de chaves NVIDIA e execução paralela de operários.

> **v2** substituiu o antigo parser-por-regex (que adivinhava o arquivo-alvo a partir de texto livre) por um **contrato JSON estrito de operações `create`/`patch`**. Isso elimina a causa-raiz dos bugs de sobrescrita (ex: `style.css` trocado por snippet). Todos os modelos por camada foram validados ao vivo contra o catálogo NVIDIA NIM.

---

## 🏛️ Arquitetura das 3 Camadas de Inteligência

```
┌─────────────────────────────────────────────────────────┐
│   CAMADA 1: ESTRATÉGICA (Claude Sonnet via agy CLI)     │ -> Arquiteta o escopo macro
└────────────────────────────┬────────────────────────────┘    e gera o contrato de arquitetura.
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│      CAMADA 2: GERENCIAL (z-ai/glm-5.2 / NVIDIA)        │ -> Lê contexto massivo do projeto
└────────────────────────────┬────────────────────────────┘    e gera o grafo de tarefas atômicas.
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│  CAMADA 3: OPERACIONAL (qwen3-coder-480b / agy CLI)     │ -> Execução paralela com contrato
└─────────────────────────────────────────────────────────┘    JSON de escrita + Auto-Healing.
```

### 1. Camada 1: Estratégica (Diretor de Arquitetura)
* **Provedor:** `antigravity` (Antigravity CLI `agy`) — tool use real.
* **Modelo:** `Claude Sonnet 4.6 (Thinking)` via CLI.
* **Fallback NVIDIA dedicado:** `layer1_fallback_model = z-ai/glm-5.2` — **desacoplado** da Camada 2 (antes reaproveitava `layer2_model` implicitamente; corrigido em `orchestrator.py::run_claude_cli`).
* **Função:** Recebe o objetivo macro do usuário e gera o contrato de arquitetura com módulos e dependências.

### 2. Camada 2: Gerencial (Gerente Técnico)
* **Provedor:** `nvidia` (NVIDIA NIM API HTTP).
* **Modelos:** `layer2_model = z-ai/glm-5.2` (1M de contexto, SOTA coding/agentic) | Fallback: `meta/llama-3.3-70b-instruct`.
* **Função:** Lê o snapshot dos arquivos reais do projeto (`_read_project_files`) e decompõe a arquitetura em tarefas atômicas.
* **Regra de contrato:** cada `instruction` gerada já embute o trecho exato do arquivo a alterar quando a tarefa é `patch` — o operário recebe só a tarefa, não o snapshot inteiro. Isso permite que o operário produza um `search` que case exatamente 1x.
* **Regra CWD:** trata o Diretório Alvo como diretório corrente (estilo PowerShell `cd`). Gera tarefas que modificam os arquivos existentes diretamente, nunca cria arquivos soltos sem ligação com o projeto.

### 3. Camada 3: Operacional (Workers de Execução)
* **Provedores:** `nvidia` (API, contrato JSON) & `antigravity`/`claude_code` (CLI, tool use real).
* **Modelos:** `layer3_model = qwen/qwen3-coder-480b-a35b-instruct` (256k ctx, dedicado a código) | Fallback: `nvidia/nemotron-3-nano-30b-a3b`.
* **Função:** Executa alterações de código em paralelo.
* **Dois caminhos de escrita distintos:**
  * **CLI (`agy`, `claude`):** já editam arquivos via tool use — o motor só captura/reporta o que a CLI fez. **Não** passam por `apply_json_contract`.
  * **API `nvidia` (texto puro):** **obrigada** a responder em JSON estrito de operações (ver abaixo). Nunca texto livre.

---

## 📝 Contrato de Escrita em Disco (`worker_pool.py::apply_json_contract`)

O operário NVIDIA responde **apenas** com JSON estrito (`LAYER3_WORKER_SYSTEM_PROMPT`):

```json
{
  "operations": [
    { "path": "app.js", "type": "create", "content": "// conteúdo COMPLETO do arquivo novo" },
    { "path": "style.css", "type": "patch", "search": "trecho EXATO existente", "replace": "novo trecho" }
  ]
}
```

**Regras de validação (determinísticas, sem heurística de adivinhação):**
* `type: "create"` — permitido **apenas** se o arquivo não existir, **ou** se a tarefa trouxer `allow_overwrite: true` (refatoração total pedida pela Camada 2). Caso contrário é rejeitado e força `patch`.
* `type: "patch"` — `search` deve casar **exatamente 1 vez** no arquivo (mesmo princípio do `str_replace`). 0 ou 2+ ocorrências → falha explícita sem gravar nada, com erro estruturado (arquivo, trecho procurado) alimentando o Auto-Healing.
* JSON malformado → falha explícita, mesma rota de Auto-Healing.
* **Backup `.bak`** automático antes de qualquer `patch`/`create` sobre arquivo existente.
* Blocos de shell (`mkdir`, `ls`, `cd`, `rm`...) são proibidos dentro do contrato.

---

## 🔧 Recursos & Mecanismos Avançados

### Auto-Healing Determinístico (redesenhado, teto de 3 tentativas)
> Removida a antiga varredura de palavras-chave (`error:`, `exception`, `traceback`) no stdout de execuções bem-sucedidas — causava falso positivo sempre que o código legítimo continha um `try/except`.

* **Gatilhos estruturais (não por palavra-chave):**
  1. JSON de operação malformado.
  2. `search` de `patch` que não casa exatamente 1x.
  3. **Checagem de sintaxe pós-escrita** (`worker_pool.py::_syntax_check`): `python -m py_compile` para `.py`, `node --check` para `.js`, `json.loads()` para `.json`. Erro real → aciona com a mensagem exata do compilador.
* O erro **estruturado exato** vai para o prompt de correção (não mais um trecho arbitrário de stdout).
* `healing_attempts` é **variável local** de `_run_nvidia_worker` — corrige o vazamento de estado do antigo `self._healing_attempts` (contador reaproveitado entre tarefas).
* Teto configurável: `auto_healing_max_attempts = 3`.

### Roteador Resiliente NVIDIA NIM (`backend/nvidia_router.py`)
* **Pool de Chaves:** múltiplas `nvapi-...` em `data/nvidia_keys.json`.
* **Vazão Controlada:** semáforo assíncrono, janela deslizante de 60s, `nvidia_safe_rpm = 35` por chave (evita `429`).
* **Rotação Automática:** em `429`, rotaciona para a próxima chave do pool.
* **`list_catalog()`** e **`validate_keys()`** reaproveitam `GET /v1/models` como teste leve (não gastam chat completions).

### Catálogo NVIDIA ao Vivo (fonte de verdade única)
* Endpoint `GET /api/nvidia-catalog/check`: consulta `GET https://integrate.api.nvidia.com/v1/models` e compara contra os modelos configurados por camada.
* Modelo configurado que sumiu do catálogo → `missing`, exibido como **card de alerta** na UI.
* **Nunca troca modelo automaticamente** — o usuário confirma via dropdown. `auto_fix()` só verifica/reporta, jamais sobrescreve a escolha do usuário.

### RTK — Rust Token Killer (regra global 1)
* `settings.use_rtk` agora tem **efeito real**: `ai_providers.py::build_command` prefixa `rtk ` ao comando CLI final quando ligado.
* Aplicado em **todas** as chamadas CLI: Camada 1 (`orchestrator.py`), Camada 3 (`worker_pool.py`) e teste de provedor. A checagem de sintaxe (`node --check`/`py_compile`) fica fora do escopo (não é provider CLI).

### Caveman Mode em Todas as Camadas (regra global 2)
* `CAVEMAN_PROMPT` injetado quando `settings.use_caveman`: Camada 1 (`orchestrator.py`), Camada 2 (`manager_layer.py`), Camada 3 via API e via CLI (`worker_pool.py`) e Auto-Healing.

### Detecção Unificada de Erro/Cota (`backend/error_detection.py`)
* `is_quota_or_error()` e `is_rate_limited()` — lista única de keywords centralizada, reusada por `orchestrator.py`, `worker_pool.py` e `manager_layer.py` (antes duplicada com variações).

### Claude Code CLI reativado (concorrência limitada)
* Provider `claude_code` permanece `is_active=True`.
* `WorkerPool` mantém `asyncio.Semaphore(1)` **dedicado** a `provider == "claude_code"` — 1 execução simultânea (1 sessão OAuth, sem rotação de perfil). `antigravity` e `nvidia` seguem paralelos no pool geral.

### Validação Anti-Alucinação (`prompt_templates.py::VALIDATION_PROMPT`)
* O Parecer Final baseia-se **apenas** nos relatórios reais de execução — proibido inventar arquivos inexistentes.

---

## 🎨 UI — Aba Provedores (redesenhada, 3 seções)

Modal `#providers-modal` dividido em `<details>`:
1. **Provedores CLI** — Antigravity / Claude Code, badge "Nativo".
2. **Pool de Chaves NVIDIA** — status individual por chave (✅ válida · `12/35 RPM` / 🔴 erro) via `/api/nvidia-keys/status`.
3. **Modelos por Camada** — dropdowns populados do catálogo ao vivo + botão "🔄 Verificar catálogo" + card de alerta de desatualização.

> **Bug corrigido:** `fetchNvidiaKeys()` vivia num bloco morto de `#btn-providers` (ID inexistente no HTML) e nunca disparava. Movido para o listener de `#btn-manage-providers`.

---

## ✅ Bugs Corrigidos na v2

1. **`style.css` sobrescrito** — resolvido pelo contrato JSON: `create` proibido em arquivo existente sem `allow_overwrite`; edições exigem `patch` com `search` exato.
2. **Auto-Healing por falso positivo** — removida a varredura de keywords em stdout de sucesso; gatilhos agora são estruturais.
3. **Vazamento de estado do healing** — `healing_attempts` virou variável local.
4. **Chaves NVIDIA invisíveis na UI** — listener corrigido.
5. **`DATA_DIR` hardcoded** — agora `Path(__file__).resolve().parent.parent / "data"` (portátil entre máquinas/SO).
6. **Fallback da Camada 1** — usa `layer1_fallback_model` explícito, não mais `layer2_model` implícito.

---

## 📁 Estrutura de Arquivos Principais

* **`run.py`**: Ponto de entrada FastAPI.
* **`backend/orchestrator.py`**: Orquestrador de 2 fases (Camada 1 + Camada 2). Parser CWD para Windows com espaços; RTK/Caveman na Camada 1.
* **`backend/manager_layer.py`**: Camada Gerencial — analisa o código real do projeto e decompõe em tarefas.
* **`backend/worker_pool.py`**: Workers da Camada 3 — `apply_json_contract`, `_syntax_check`, Auto-Healing determinístico, semáforo `claude_code`, backup `.bak`.
* **`backend/nvidia_router.py`**: Roteador assíncrono — RPM, rotação de chaves, `list_catalog`, `validate_keys`.
* **`backend/ai_providers.py`**: Registry de provedores, `build_command` (RTK), diagnóstico HTTP/CLI.
* **`backend/config_manager.py`**: Configurações (`SettingsConfig`), perfis, chaves NVIDIA, `DATA_DIR` portátil.
* **`backend/error_detection.py`**: Detecção unificada de erro/cota.
* **`backend/prompt_templates.py`**: Prompts das camadas 1–3, contrato de escrita, Auto-Healing, Validação.
* **`frontend/`**: Interface web glassmorphism (HTML/CSS/JS) — modal de provedores em 3 seções.

---

## 🚀 Como Executar

```powershell
# Instalar dependências
pip install -r requirements.txt

# Iniciar o servidor Singularity
python run.py
```

Acesse o painel web em **`http://127.0.0.1:8000`**.
