# Arquitetura do Singularity - Sistema Orquestrador IA

## 🧠 Chefe Central (Orquestrador)
- O Chefe Central é o modelo **Claude Sonnet 4.6 (Thinking)** da Anthropic.
- Função: Receber o objetivo macro do usuário, analisar a estrutura do projeto e decompor o plano técnico em tarefas.

## 👷 Operários Técnicos (Workers)
- Executam as tarefas individuais definidas pelo Chefe Central.
- Suportam múltiplos provedores ativos no sistema (`Antigravity CLI`, `Claude Code CLI`, etc.).
