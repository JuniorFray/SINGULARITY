"""
backend/manager_layer.py
CAMADA 2: Gerencial — DeepSeek-R1 via NVIDIA NIM.
Recebe JSON de arquitetura do Claude (Camada 1) + código atual do projeto
e gera o grafo detalhado de tarefas atômicas para os operários (Camada 3).
"""

import os
import json
from typing import Dict, Any, List, Optional, Callable

from backend.config_manager import config_manager
from backend.prompt_templates import LAYER2_MANAGER_PROMPT, CAVEMAN_PROMPT

MAX_CONTEXT_CHARS = 400_000  # ~300k tokens de código (metade da janela para segurança)
# Limite POR ARQUIVO. O valor antigo (5000) cortava arquivos reais do projeto
# (ex: app.js de 24k → só 21% visível), impedindo a Camada 2 de embutir uma âncora
# de patch correta e empurrando o operário a recriar/sobrescrever o arquivo (apagando
# jogos). Elevado para caber os arquivos completos de um hub típico, com marcação
# explícita quando ainda assim precisar truncar.
PER_FILE_CHARS = 40_000


def _read_project_files(work_dir: str, extensions: tuple = (".py", ".js", ".ts", ".html", ".css", ".json", ".md")) -> str:
    """Lê os arquivos do projeto e compõe um snapshot de contexto para a Camada 2."""
    if not work_dir or not os.path.exists(work_dir):
        return "Diretório de trabalho não encontrado."

    context_parts = []
    total_chars = 0

    for root, dirs, files in os.walk(work_dir):
        # Ignorar diretórios de dependências
        dirs[:] = [d for d in dirs if d not in {"node_modules", ".git", "__pycache__", "venv", ".venv", "dist", "build"}]
        for fname in sorted(files):
            if fname.endswith(".bak"):
                continue  # ignorar backups gerados pelo próprio contrato de escrita
            if not any(fname.endswith(ext) for ext in extensions):
                continue
            fpath = os.path.join(root, fname)
            rel_path = os.path.relpath(fpath, work_dir)
            try:
                with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                if len(content) > PER_FILE_CHARS:
                    body = content[:PER_FILE_CHARS] + "\n[...ARQUIVO TRUNCADO — maior que o limite por arquivo...]"
                else:
                    body = content
                entry = f"\n### {rel_path}\n```\n{body}\n```\n"
                total_chars += len(entry)
                if total_chars > MAX_CONTEXT_CHARS:
                    context_parts.append("\n[...contexto truncado por limite de tokens...]")
                    break
                context_parts.append(entry)
            except Exception:
                continue

    return "".join(context_parts) if context_parts else "Nenhum arquivo encontrado no diretório."


class ManagerLayer:
    def __init__(self, broadcaster_fn: Optional[Callable] = None):
        self.broadcaster_fn = broadcaster_fn

    async def _broadcast(self, text: str, log_type: str = "info"):
        if self.broadcaster_fn:
            await self.broadcaster_fn({
                "type": "terminal_log",
                "worker_id": "camada_2",
                "text": text,
                "log_type": log_type
            })

    async def decompose_to_tasks(
        self,
        layer1_json: Dict[str, Any],
        work_dir: str,
        macro_goal: str
    ) -> Dict[str, Any]:
        """
        Fase 1B: Recebe o contrato JSON do Claude (Camada 1) e 
        decompõe em tarefas atômicas detalhadas usando DeepSeek-R1.
        """
        from backend.nvidia_router import nvidia_router

        await self._broadcast("🧠 [CAMADA 2] DeepSeek-R1 analisando arquitetura e código do projeto...", "info")

        keys = config_manager.get_nvidia_keys()
        if not keys:
            await self._broadcast("⚠️ [CAMADA 2] Sem chaves NVIDIA. Usando plano simples do Claude (Camada 1).", "warning")
            return layer1_json

        # Atualiza o roteador com as chaves atuais
        nvidia_router.update_keys(keys)

        # Snapshot do código atual
        await self._broadcast("📁 [CAMADA 2] Lendo arquivos do projeto para contexto...", "info")
        project_context = _read_project_files(work_dir)

        # Monta payload para o DeepSeek-R1
        architecture_json = json.dumps(layer1_json, indent=2, ensure_ascii=False)
        user_content = LAYER2_MANAGER_PROMPT.format(
            macro_goal=macro_goal,
            work_dir=work_dir,
            architecture_json=architecture_json,
            project_context=project_context[:MAX_CONTEXT_CHARS]
        )

        # Caveman aplicado à Camada 2 (antes só era injetado nas Camadas 1 e 3-CLI)
        system_prompt = (
            "Você é o Gerente de Projetos Técnico do ecossistema Singularity. "
            "Você tem acesso a uma janela de contexto massiva com o código atual do projeto. "
            "Sua função é gerar APENAS um JSON válido com o grafo de tarefas atômicas, "
            "sem markdown adicional, sem explicações."
        )
        if config_manager.state.settings.use_caveman:
            system_prompt = f"{CAVEMAN_PROMPT}\n\n{system_prompt}"

        try:
            raw_response = await nvidia_router.execute_layer2(
                system_prompt=system_prompt,
                user_content=user_content,
                broadcaster_fn=self.broadcaster_fn
            )

            plan = _extract_json(raw_response)
            if plan and "tasks" in plan:
                await self._broadcast("✅ [CAMADA 2] Grafo de tarefas gerado com sucesso!", "success")
                return plan

            # AUTO-CORREÇÃO: JSON inválido → 1 re-prompt pedindo SÓ o JSON (igual ao operário).
            await self._broadcast("🔧 [CAMADA 2] JSON inválido — pedindo correção ao modelo...", "warning")
            fix_prompt = (
                "Sua resposta anterior NÃO era um JSON válido com a chave 'tasks'. "
                "Responda AGORA APENAS com o objeto JSON válido (começando com '{' e terminando com '}'), "
                "sem texto fora do JSON, sem markdown e sem blocos <think>. Mantenha o conteúdo, só "
                "corrija a sintaxe.\n\nSUA RESPOSTA ANTERIOR:\n" + (raw_response or "")[:6000]
            )
            try:
                raw2 = await nvidia_router.execute_layer2(
                    system_prompt=system_prompt,
                    user_content=fix_prompt,
                    broadcaster_fn=self.broadcaster_fn
                )
                plan2 = _extract_json(raw2)
                if plan2 and "tasks" in plan2:
                    await self._broadcast("✅ [CAMADA 2] JSON corrigido no re-prompt.", "success")
                    return plan2
            except Exception as e2:
                print(f"[ManagerLayer] Re-prompt falhou: {e2}")

            await self._broadcast("⚠️ [CAMADA 2] JSON ainda inválido após correção. Usando fallback.", "warning")
            return layer1_json

        except Exception as e:
            await self._broadcast(f"❌ [CAMADA 2] Erro: {e}. Usando plano da Camada 1.", "error")
            return layer1_json


def _balanced_from(t: str, start: int) -> Optional[str]:
    """Bloco de chaves balanceado começando em `start` (ignora chaves dentro de strings)."""
    depth = 0
    in_str = False
    esc = False
    for j in range(start, len(t)):
        c = t[j]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return t[start:j + 1]
    return None


def _iter_balanced(t: str):
    """Gera cada bloco `{...}` balanceado de nível superior, da esquerda para a direita.
    Robusto a raciocínio/JSON inválido intercalado (ex: reasoning com `{a:b}` antes do JSON real)."""
    i, n = 0, len(t)
    while i < n:
        if t[i] == "{":
            block = _balanced_from(t, i)
            if block:
                yield block
                i += len(block)
                continue
        i += 1


def _try_load(raw: str) -> Optional[Dict[str, Any]]:
    """Tenta carregar JSON; se falhar, aplica reparo leve (remove vírgula sobrando) e tenta de novo."""
    import re
    for attempt in (raw, re.sub(r",(\s*[}\]])", r"\1", raw)):
        try:
            obj = json.loads(attempt)
            if isinstance(obj, dict):
                return obj
        except Exception:
            continue
    return None


def _extract_json(text: str) -> Optional[Dict[str, Any]]:
    """Extração TOLERANTE de JSON para modelos reasoning (glm-5.2 etc.): remove blocos <think>,
    cercas de código, e tenta (a) cerca ```json, (b) chaves balanceadas mais externas,
    (c) do primeiro '{' ao último '}'. Cada candidato passa por reparo leve."""
    import re
    if not text:
        return None
    t = text.strip()
    # Remove APENAS blocos de raciocínio FECHADOS (não apagar o resto quando <think> não fecha).
    t = re.sub(r"<think>.*?</think>", "", t, flags=re.DOTALL | re.IGNORECASE)

    candidates = []
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", t, re.DOTALL)
    if fence:
        candidates.append(fence.group(1))
    candidates.extend(_iter_balanced(t))  # todos os blocos {...} balanceados
    first, last = t.find("{"), t.rfind("}")
    if first != -1 and last > first:
        candidates.append(t[first:last + 1])  # último recurso

    parsed = []
    for raw in candidates:
        obj = _try_load(raw)
        if obj is not None:
            parsed.append(obj)
    # Prefere o objeto que realmente é um plano (tem 'tasks')
    for obj in parsed:
        if "tasks" in obj:
            return obj
    if parsed:
        return parsed[0]
    print("[ManagerLayer] Nenhum JSON válido extraído da resposta da Camada 2.")
    return None
