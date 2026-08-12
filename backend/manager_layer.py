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
from backend.prompt_templates import LAYER2_MANAGER_PROMPT

MAX_CONTEXT_CHARS = 400_000  # ~300k tokens de código (metade da janela para segurança)


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
            if not any(fname.endswith(ext) for ext in extensions):
                continue
            fpath = os.path.join(root, fname)
            rel_path = os.path.relpath(fpath, work_dir)
            try:
                with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                entry = f"\n### {rel_path}\n```\n{content[:5000]}\n```\n"
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

        try:
            raw_response = await nvidia_router.execute_layer2(
                system_prompt=(
                    "Você é o Gerente de Projetos Técnico do ecossistema Singularity. "
                    "Você tem acesso a uma janela de contexto massiva com o código atual do projeto. "
                    "Sua função é gerar APENAS um JSON válido com o grafo de tarefas atômicas, "
                    "sem markdown adicional, sem explicações."
                ),
                user_content=user_content,
                broadcaster_fn=self.broadcaster_fn
            )

            await self._broadcast("✅ [CAMADA 2] Grafo de tarefas gerado com sucesso!", "success")
            plan = _extract_json(raw_response)
            if plan and "tasks" in plan:
                return plan
            else:
                await self._broadcast("⚠️ [CAMADA 2] JSON inválido. Usando plano da Camada 1.", "warning")
                return layer1_json

        except Exception as e:
            await self._broadcast(f"❌ [CAMADA 2] Erro: {e}. Usando plano da Camada 1.", "error")
            return layer1_json


def _extract_json(text: str) -> Optional[Dict[str, Any]]:
    import re
    if not text:
        return None
    try:
        match = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
        if match:
            return json.loads(match.group(1))
        match_raw = re.search(r"(\{.*\})", text, re.DOTALL)
        if match_raw:
            return json.loads(match_raw.group(1))
    except Exception as e:
        print(f"[ManagerLayer] Erro ao extrair JSON: {e}")
    return None
