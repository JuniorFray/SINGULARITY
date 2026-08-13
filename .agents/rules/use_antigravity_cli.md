# Regra de Provedores CLI (Antigravity + Claude Code)

- O projeto Singularity usa o **Antigravity CLI (`agy`)** como provedor CLI principal dos operários (paralelismo livre).
- O **Claude Code CLI (`claude`)** está **ATIVO** (`is_active=true`), porém **limitado a 1 execução simultânea**:
  - `WorkerPool` mantém um `asyncio.Semaphore(1)` dedicado a tarefas com `provider == "claude_code"`.
  - Os demais providers (`antigravity`, `nvidia`) continuam paralelos normalmente no pool geral.
  - **Sem rotação de perfil/conta para `claude_code`** — decisão do usuário: 1 sessão OAuth só.
- O failover/rotação de modelos e contas ocorre no ecossistema `agy` e, quando a CLI estoura cota,
  o operário faz failover para a **API NVIDIA NIM** usando o contrato JSON de escrita.
