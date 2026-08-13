"""
backend/error_detection.py
Detecção unificada de erro/cota. Antes esta lógica estava duplicada com pequenas
variações em orchestrator.py, worker_pool.py e manager_layer.py — o que causava
comportamento inconsistente de failover. Agora existe UMA lista de keywords e UMA
função canônica reusada por todos.
"""

# Keywords que sinalizam esgotamento de cota / limite de taxa / falha de auth/modelo
# no output (stdout/stderr) de um provedor CLI ou na mensagem de exceção de uma API.
# União de todas as variações que existiam espalhadas pelo código.
QUOTA_ERROR_KEYWORDS = [
    "quota",
    "rate limit",
    "429",
    "resource_exhausted",
    "limit reached",
    "individual quota reached",
    "please upgrade",
    "invalid model",
    "not recognized",
    "timeout waiting",
    "not logged in",
    "please run /login",
    "login required",
]

# Subconjunto estrito de "429 / rate limit" — usado quando a decisão é
# "rotacionar chave" (limite de taxa) e não "trocar de modelo/perfil".
RATE_LIMIT_KEYWORDS = ["429", "rate limit", "quota"]


def is_quota_or_error(output: str) -> bool:
    """Retorna True se o texto indica cota esgotada, limite de taxa ou erro
    de autenticação/modelo que justifique failover (rotação de chave/perfil/modelo)."""
    if not output:
        return False
    low = output.lower()
    return any(kw in low for kw in QUOTA_ERROR_KEYWORDS)


def is_rate_limited(output: str) -> bool:
    """Retorna True apenas para 429/limite de taxa/cota — sinal para rotacionar
    a chave do pool NVIDIA (não para trocar de modelo)."""
    if not output:
        return False
    low = output.lower()
    return any(kw in low for kw in RATE_LIMIT_KEYWORDS)
