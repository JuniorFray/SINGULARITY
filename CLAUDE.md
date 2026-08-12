# Singularity — Sistema Orquestrador IA Multiagente

Sistema Orquestrador IA de alta capacidade com arquitetura em 3 camadas, auto-healing de código, roteamento resiliente com pool de chaves NVIDIA e execução paralela de operários.

---

## 🏛️ Arquitetura das 3 Camadas de Inteligência

```
┌─────────────────────────────────────────────────────────┐
│         CAMADA 1: ESTRATÉGICA (Claude Sonnet / agy)     │ -> Arquiteta o escopo macro
└────────────────────────────┬────────────────────────────┘    e gera o contrato JSON global.
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│     CAMADA 2: GERENCIAL (DeepSeek-R1 / NVIDIA NIM)      │ -> Lê contexto massivo do projeto
└────────────────────────────┬────────────────────────────┘    e gera o grafo de tarefas atômicas.
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│     CAMADA 3: OPERACIONAL (Llama / Nemotron / agy)      │ -> Execução de código em paralelo
└─────────────────────────────────────────────────────────┘    com Auto-Healing (3 tentativas).
```

### 1. Camada 1: Estratégica (Diretor de Arquitetura)
* **Provedor:** `antigravity` (Antigravity CLI `agy`)
* **Modelo:** `Claude Sonnet 4.6 (Thinking)`
* **Função:** Recebe o objetivo macro do usuário e gera o contrato de arquitetura em JSON com os módulos e dependências principais.

### 2. Camada 2: Gerencial (Gerente Técnico)
* **Provedor:** `nvidia` (NVIDIA NIM API HTTP)
* **Modelos:** `meta/llama-3.3-70b-instruct` | Fallback: `nvidia/nemotron-3-nano-30b-a3b`
* **Função:** Lê o snapshot dos arquivos de código do projeto (até 500k tokens) e decompõe a arquitetura da Camada 1 em tarefas atômicas prontas para os operários.
* **Regra CWD (atualização):** Trata o Diretório Alvo como o diretório de trabalho corrente (estilo PowerShell `cd`). Lê os arquivos existentes do projeto (index.html, app.js, style.css etc.) e gera tarefas que modificam esses arquivos diretamente, nunca cria arquivos soltos/genéricos sem ligação com o projeto.

### 3. Camada 3: Operacional (Workers de Execução)
* **Provedores:** `nvidia` (API) & `antigravity` (CLI)
* **Modelos:** `meta/llama-3.1-8b-instruct` | `nvidia/nemotron-3-nano-30b-a3b`
* **Função:** Executa alterações de código e comandos de terminal em paralelo.
* **Regra (atualização):** Na PRIMEIRA LINHA de cada bloco de código gerado, o modelo é instruído a colocar o caminho relativo do arquivo em comentário (ex: `// app.js`, `<!-- index.html -->`).

---

## 🔧 Recursos & Mecanismos Avançados

### Auto-Healing de Código (3 Tentativas sem Custo)
* Intercepta erros no `stdout`/`stderr` do terminal (`SyntaxError`, `AssertionError`, etc.).
* O script envia o erro + código problemático para a Camada Gerencial via NVIDIA NIM.
* O modelo reescreve o prompt com instruções corretivas diretas.
* O operário tenta a correção por até 3 ciclos antes de escalar.

### Roteador Resiliente NVIDIA NIM (`backend/nvidia_router.py`)
* **Pool de Chaves:** Armazena múltiplas chaves `nvapi-...` em `data/nvidia_keys.json`.
* **Vazão Controlada:** Semáforo assíncrono com janela deslizante de 60s ajustado para 35 RPM por chave (evita erros `429`).
* **Rotação Automática:** Em caso de `429`, rotaciona instantaneamente para a próxima chave do pool.

### Inferência Inteligente de Caminhos de Arquivo (`backend/worker_pool.py`)
* Se a IA omitir o comentário de caminho na primeira linha, o motor analisa o título e instrução da tarefa e usa heurística para inferir o arquivo-alvo (ex: título contendo `index.html` e `hub` → grava em `index.html`).
* **Proteção de Integridade:** Recusa sobrescrever arquivos com mais de `200 bytes` por snippets menores que `50 bytes`.
* **Backup Automático `.bak`:** Antes de modificar qualquer arquivo, cria cópia de segurança (`arquivo.ext.bak`).
* **Filtro Anti-Corrupção:** Ignora blocos de código identificados como terminal/bash (`ls`, `dir`, `cd`, etc.) para evitar sobrescrita acidental de código JavaScript/HTML.

### Gestão de Provedores Persistente (`data/providers.json`)
* Provedor Ollama totalmente removido.
* Provedor `nvidia` integrado nativamente com modelos testados e ativos (`meta/llama-3.1-8b-instruct`, `nvidia/nemotron-3-nano-30b-a3b`, `meta/llama-3.3-70b-instruct`, `meta/llama-3.2-11b-vision-instruct`).
* Modais de interface permitem adicionar novos provedores e gerenciar o pool de chaves NVIDIA em tempo real.

### Validação Anti-Alucinação (`backend/prompt_templates.py` — `VALIDATION_PROMPT`)
* O Parecer Final é instruído a basear-se **apenas** nos relatórios reais de execução.
* Proibido mencionar ou inventar arquivos que não existam no projeto (como `AndroidManifest.xml`).

---

## ⚠️ Bugs Conhecidos & Problemas em Análise

> Estes problemas foram identificados em testes reais e ainda precisam de solução estrutural no motor de orquestração:

1. **Workaround do `style.css`:** O orquestrador substituiu o CSS original do projeto alvo por um snippet de 5 linhas. Os arquivos CSS do projeto alvo devem ser tratados como **somente-leitura para operações de append**, nunca substituição total, a menos que o objetivo macro explicitamente peça refatoração visual completa.

2. **Escopo CWD ainda imperfeito:** Em algumas execuções, o caminho `D:\APP android teste` (com espaço) foi truncado para `D:\APP` por regex. Corrigido em `orchestrator.py` mas requer testes adicionais com múltiplos espaços.

3. **Coexistência de operações estruturais e de detalhe:** O orquestrador ainda mistura tarefas de "criação de arquivo" e "edição pontual de trecho de código" sem distinção clara. Tarefas de edição pontual precisam de um mecanismo de PATCH (inserção de bloco específico), não sobrescrita total.

---

## 📁 Estrutura de Arquivos Principais

* **`run.py`**: Ponto de entrada da aplicação FastAPI.
* **`backend/orchestrator.py`**: Orquestrador central de 2 fases (Camada 1 + Camada 2). Inclui parser de caminho CWD corrigido para Windows com espaços.
* **`backend/manager_layer.py`**: Camada Gerencial que analisa o código do projeto via DeepSeek/Llama.
* **`backend/worker_pool.py`**: Workers paralelos da Camada 3 com Auto-Healing, proteção de integridade e backup automático.
* **`backend/nvidia_router.py`**: Roteador assíncrono com controle de vazão RPM e rotação de chaves.
* **`backend/ai_providers.py`**: Registry de provedores e testes de diagnóstico HTTP/CLI.
* **`backend/config_manager.py`**: Gerenciador de configurações, perfis Google e chaves NVIDIA.
* **`backend/prompt_templates.py`**: Prompts especializados para cada camada do sistema (Camadas 1, 2, 3, Auto-Healing e Validação).
* **`frontend/`**: Interface web responsiva em glassmorphism (HTML/CSS/JS).

---

## 🚀 Como Executar

```powershell
# Instalar dependências
pip install -r requirements.txt

# Iniciar o servidor Singularity
python run.py
```

Acesse o painel web em **`http://127.0.0.1:8000`**.
