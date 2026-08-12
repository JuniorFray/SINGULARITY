# Antigravity CLI Only Rule

- O projeto Singularity utiliza exclusivamente o **Antigravity CLI (`agy`)** para todos os operários de IA.
- O provedor `claude_code` está desativado devido a limitações de login OAuth no ambiente de subprocessos.
- O failover e a rotação de modelos/contas devem ocorrer 100% dentro do ecossistema `agy`.
