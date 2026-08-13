import os
import sys
import re
import json
import asyncio
import shutil

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
from typing import Dict, Any, Callable, Optional, List
from backend.config_manager import config_manager
from backend.ai_providers import provider_registry
from backend.prompt_templates import CAVEMAN_PROMPT, LAYER3_WORKER_SYSTEM_PROMPT
from backend.error_detection import is_quota_or_error


# ─────────────────────────────────────────────────────────────────────────────
# CONTRATO DE ESCRITA EM DISCO (provider nvidia — API texto puro)
#
# Substitui o antigo apply_ai_output_to_filesystem (parser por regex sobre texto
# livre, que adivinhava o arquivo alvo e sobrescrevia arquivos existentes — bug do
# style.css). Agora o operário DEVE responder com JSON { "operations": [...] } e
# esta função valida/aplica cada operação de forma determinística. Qualquer falha
# (JSON malformado, patch não encontrado, sintaxe inválida) retorna erro estruturado
# — nada é gravado quando a operação é rejeitada — e alimenta o Auto-Healing.
# ─────────────────────────────────────────────────────────────────────────────

def _backup(path: str):
    """Cria cópia .bak antes de modificar um arquivo existente (mantido da versão anterior)."""
    try:
        shutil.copy2(path, path + ".bak")
    except Exception:
        pass


def _extract_json_obj(text: str) -> Optional[Dict[str, Any]]:
    """Extrai o objeto JSON da resposta do operário, tolerando cercas ```json acidentais."""
    if not text:
        return None
    t = text.strip()
    # Preferir bloco dentro de cercas de código, se houver
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", t, re.DOTALL)
    raw = fence.group(1) if fence else None
    if raw is None:
        # Senão, pegar do primeiro '{' ao último '}' (bloco de chaves mais externo)
        first = t.find("{")
        last = t.rfind("}")
        if first != -1 and last > first:
            raw = t[first:last + 1]
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def _validate_file_syntax(path: str) -> Optional[str]:
    """Checagem de sintaxe determinística pós-escrita, conforme a extensão.
    Retorna a mensagem de erro EXATA do compilador/linter, ou None se OK
    (ou se a extensão/ferramenta não estiver disponível — não bloqueia nesse caso).
    Isto é preciso, ao contrário de adivinhar erro por palavra-chave no stdout."""
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".py":
            import py_compile
            try:
                py_compile.compile(path, doraise=True)
                return None
            except py_compile.PyCompileError as e:
                return str(e)
        elif ext == ".json":
            with open(path, "r", encoding="utf-8") as f:
                json.load(f)
            return None
        elif ext in (".js", ".mjs", ".cjs"):
            node = shutil.which("node")
            if not node:
                return None  # node ausente — não bloquear a escrita
            import subprocess
            res = subprocess.run(
                [node, "--check", path],
                capture_output=True, text=True, timeout=15,
                encoding="utf-8", errors="replace"
            )
            if res.returncode != 0:
                return (res.stderr or res.stdout or "node --check falhou").strip()
            return None
    except Exception as e:
        return f"Falha ao validar sintaxe de {os.path.basename(path)}: {e}"
    return None


def apply_json_contract(output_text: str, work_dir: str, allow_overwrite: bool = False) -> Dict[str, Any]:
    """Valida e aplica o contrato JSON de operações de arquivo. Retorna resultado
    estruturado consumido pelo Auto-Healing determinístico."""
    result: Dict[str, Any] = {
        "ok": False,
        "malformed": False,
        "affected_files": [],
        "errors": [],           # strings legíveis (viram prompt de correção)
        "operations_total": 0,
        "operations_ok": 0,
    }
    if not work_dir:
        result["errors"].append("work_dir não definido — nada foi gravado.")
        return result

    payload = _extract_json_obj(output_text)
    if not payload or not isinstance(payload.get("operations"), list):
        # JSON malformado/ausente → gatilho de Auto-Healing
        result["malformed"] = True
        result["errors"].append(
            "JSON de operações malformado ou ausente. Esperado objeto com chave 'operations' (lista de create/patch)."
        )
        return result

    operations = payload["operations"]
    result["operations_total"] = len(operations)
    wd_abs = os.path.normpath(os.path.abspath(work_dir))

    for idx, op in enumerate(operations):
        if not isinstance(op, dict):
            result["errors"].append(f"Operação #{idx} inválida (não é objeto).")
            continue
        op_type = (op.get("type") or "").strip().lower()
        rel_path = (op.get("path") or "").strip()
        if not rel_path:
            result["errors"].append(f"Operação #{idx} sem 'path'.")
            continue

        # Resolver caminho e impedir escape da pasta do projeto (segurança)
        target_path = rel_path if os.path.isabs(rel_path) else os.path.join(work_dir, rel_path)
        target_path = os.path.normpath(target_path)
        if not os.path.normpath(os.path.abspath(target_path)).startswith(wd_abs):
            result["errors"].append(f"{rel_path}: caminho fora da pasta do projeto — rejeitado.")
            continue

        exists = os.path.exists(target_path)

        if op_type == "create":
            content = op.get("content")
            if content is None:
                result["errors"].append(f"{rel_path}: operação 'create' sem 'content'.")
                continue
            # create só é permitido para arquivo inexistente — salvo refatoração total (allow_overwrite)
            if exists and not allow_overwrite:
                result["errors"].append(
                    f"{rel_path}: arquivo já existe — 'create' rejeitado. Use 'patch' para editar."
                )
                continue
            try:
                parent = os.path.dirname(target_path)
                if parent:
                    os.makedirs(parent, exist_ok=True)
                if exists:
                    _backup(target_path)
                with open(target_path, "w", encoding="utf-8") as f:
                    f.write(content)
            except Exception as e:
                result["errors"].append(f"{rel_path}: erro ao gravar (create): {e}")
                continue

        elif op_type == "patch":
            search = op.get("search")
            replace = op.get("replace")
            if search is None or replace is None:
                result["errors"].append(f"{rel_path}: operação 'patch' exige 'search' e 'replace'.")
                continue
            if not exists:
                result["errors"].append(f"{rel_path}: arquivo não existe — 'patch' impossível. Use 'create'.")
                continue
            try:
                with open(target_path, "r", encoding="utf-8", errors="replace") as f:
                    current = f.read()
            except Exception as e:
                result["errors"].append(f"{rel_path}: erro ao ler para patch: {e}")
                continue
            # search deve casar EXATAMENTE 1x (mesmo princípio do str_replace)
            count = current.count(search)
            if count != 1:
                snippet = current if len(current) <= 4000 else current[:4000] + "\n[...conteúdo truncado...]"
                result["errors"].append(
                    f"{rel_path}: 'search' casou {count}x (esperado exatamente 1). "
                    f"Trecho procurado:\n<<<SEARCH>>>\n{search}\n<<<END>>>\n"
                    f"Conteúdo atual real do arquivo:\n{snippet}"
                )
                continue
            try:
                _backup(target_path)
                new_content = current.replace(search, replace, 1)
                with open(target_path, "w", encoding="utf-8") as f:
                    f.write(new_content)
            except Exception as e:
                result["errors"].append(f"{rel_path}: erro ao gravar (patch): {e}")
                continue
        else:
            result["errors"].append(f"{rel_path}: 'type' inválido ('{op_type}'). Use 'create' ou 'patch'.")
            continue

        # Checagem de sintaxe determinística pós-escrita → gatilho de Auto-Healing
        syntax_err = _validate_file_syntax(target_path)
        if syntax_err:
            result["errors"].append(f"{rel_path}: erro de sintaxe pós-escrita:\n{syntax_err}")
            continue

        result["affected_files"].append(target_path)
        result["operations_ok"] += 1

    # Sucesso apenas se parseou, aplicou ao menos 1 operação e nenhuma falhou
    result["ok"] = (not result["errors"]) and result["operations_ok"] > 0
    return result


class TaskWorker:
    def __init__(
        self,
        worker_id: str,
        broadcaster_fn: Optional[Callable] = None,
        claude_code_semaphore: Optional[asyncio.Semaphore] = None
    ):
        self.worker_id = worker_id
        self.broadcaster_fn = broadcaster_fn
        # Semáforo compartilhado que limita o provider claude_code a 1 execução simultânea
        # (1 sessão OAuth só). Os demais providers seguem paralelos no pool geral.
        self.claude_code_semaphore = claude_code_semaphore
        self.is_busy = False
        self.current_task_title = ""
        self.current_provider = "antigravity"
        self.current_profile = ""
        self.current_model = ""

    async def broadcast_status(self):
        if self.broadcaster_fn:
            await self.broadcaster_fn({
                "type": "worker_status_update",
                "worker": {
                    "id": self.worker_id,
                    "is_busy": self.is_busy,
                    "provider": self.current_provider,
                    "profile": self.current_profile or "Padrão",
                    "model": self.current_model or "Padrão",
                    "current_task": self.current_task_title if self.is_busy else "Aguardando tarefa..."
                }
            })

    async def broadcast_log(self, text: str, log_type: str = "info"):
        if self.broadcaster_fn:
            await self.broadcaster_fn({
                "type": "terminal_log",
                "worker_id": self.worker_id,
                "text": text,
                "log_type": log_type,
                "provider": self.current_provider,
                "profile": self.current_profile,
                "model": self.current_model
            })

    async def _run_nvidia_worker(
        self,
        task_id: int,
        instrucao: str,
        model_pipeline: List[str],
        target_dir: str,
        allow_overwrite: bool,
        settings,
        profile_label: str = "NVIDIA Pool"
    ) -> Dict[str, Any]:
        """Executa uma tarefa da Camada 3 via NVIDIA NIM usando o contrato JSON de escrita,
        com Auto-Healing DETERMINÍSTICO. Gatilhos de correção são estruturais (JSON malformado,
        patch não encontrado, sintaxe inválida) — nunca varredura de palavras no stdout.
        O contador de tentativas é LOCAL a esta chamada (não vaza entre tarefas)."""
        from backend.nvidia_router import nvidia_router
        nvidia_router.update_keys(config_manager.get_nvidia_keys())

        # Caveman aplicado ao operário NVIDIA (antes só era aplicado na via CLI)
        system_prompt = LAYER3_WORKER_SYSTEM_PROMPT
        if settings.use_caveman:
            system_prompt = f"{CAVEMAN_PROMPT}\n\n{LAYER3_WORKER_SYSTEM_PROMPT}"

        max_healing = max(0, settings.auto_healing_max_attempts)
        healing_attempts = 0  # LOCAL — corrige o vazamento de estado do antigo self._healing_attempts
        user_content = f"TAREFA: {instrucao}"
        primary_model = model_pipeline[0] if model_pipeline else settings.layer3_model

        while True:
            res_text = await nvidia_router.execute(
                model_pipeline=model_pipeline,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
                temperature=0.2,
                broadcaster_fn=self.broadcaster_fn,
            )
            await self.broadcast_log(res_text, "stdout")

            # Aplicar o contrato num thread (I/O + subprocess node --check não bloqueiam o loop)
            contract = await asyncio.to_thread(apply_json_contract, res_text, target_dir, allow_overwrite)
            if contract["affected_files"]:
                await self.broadcast_log(
                    f"📁 [FileSystem] {len(contract['affected_files'])} arquivo(s) gravado(s) em '{target_dir}'.", "info"
                )

            base_result = {
                "task_id": task_id,
                "output": res_text,
                "attempts": healing_attempts + 1,
                "worker_id": self.worker_id,
                "provider_id": "nvidia",
                "profile_name": profile_label,
                "model": primary_model,
                "use_caveman": settings.use_caveman,
                "use_rtk": settings.use_rtk,
                "approx_tokens": int(len(res_text) / 4),
                "tokens_saved": int(len(res_text) / 4 * 0.35) if settings.use_caveman else 0,
                "affected_files": contract["affected_files"],
            }

            if contract["ok"]:
                base_result["status"] = "success"
                return base_result

            # Falha estrutural → Auto-Healing determinístico
            error_summary = "\n".join(contract["errors"])[:3500]
            trigger = "JSON malformado" if contract["malformed"] else "operação de arquivo rejeitada"

            if healing_attempts >= max_healing:
                await self.broadcast_log(
                    f"❌ [Auto-Healing] Teto de {max_healing} tentativas atingido ({trigger}). Escalando falha.", "error"
                )
                base_result["status"] = "failed"
                base_result["output"] = res_text + "\n\n[ERROS DE CONTRATO]\n" + error_summary
                return base_result

            healing_attempts += 1
            await self.broadcast_log(
                f"🔧 [Auto-Healing {healing_attempts}/{max_healing}] {trigger}. Reenviando com erro estruturado...",
                "warning"
            )
            # Reprompt do MESMO operário com o erro EXATO (não um trecho arbitrário de stdout)
            heal_prefix = f"{CAVEMAN_PROMPT}\n\n" if settings.use_caveman else ""
            user_content = (
                f"{heal_prefix}TAREFA ORIGINAL:\n{instrucao}\n\n"
                f"Sua resposta anterior FALHOU na validação do contrato de escrita. "
                f"Corrija e responda novamente APENAS com o JSON de operações válido.\n\n"
                f"ERROS EXATOS:\n{error_summary}\n\n"
                f"Lembre: use 'patch' (com 'search' casando exatamente 1x) para arquivos existentes "
                f"e 'create' apenas para arquivos novos."
            )

    async def execute(
        self,
        task_id: int,
        title: str,
        instrucao: str,
        complexity: str,
        provider_id: str = "antigravity",
        work_dir: Optional[str] = None,
        allow_overwrite: bool = False
    ) -> Dict[str, Any]:
        self.is_busy = True
        self.current_task_title = title
        self.current_provider = provider_id
        settings = config_manager.state.settings

        provider_config = provider_registry.get_provider(provider_id) or provider_registry.get_provider("antigravity")

        models = provider_config.supported_models
        if complexity == "alta" and len(models) > 0:
            modelo_selecionado = models[0]
        elif complexity == "media" and len(models) > 1:
            modelo_selecionado = models[1]
        else:
            modelo_selecionado = models[-1] if models else provider_config.default_model

        profiles = config_manager.state.profiles
        if not profiles:
            config_manager._ensure_default_profiles()
            profiles = config_manager.state.profiles

        current_profile = config_manager.get_current_profile()
        self.current_profile = current_profile.name
        self.current_model = modelo_selecionado
        await self.broadcast_status()

        await self.broadcast_log(f"🚀 [{provider_config.name}] Iniciando tarefa #{task_id}: '{title}' (Complexidade: {complexity})")

        total_attempts = max(1, len(models)) * max(1, len(profiles))
        attempt = 0

        # Caveman para a via CLI (o operário NVIDIA recebe caveman no system prompt do contrato)
        final_instruction = instrucao
        if settings.use_caveman:
            final_instruction = f"{CAVEMAN_PROMPT}\n\nTAREFA: {instrucao}"
            await self.broadcast_log("🦴 [Otimização] Modo Caveman aplicado ao prompt.")

        target_dir = work_dir if (work_dir and os.path.exists(work_dir)) else config_manager.state.settings.active_work_dir
        exec_cwd = target_dir if (target_dir and os.path.exists(target_dir)) else None

        # ─── EXECUÇÃO VIA NVIDIA NIM API (contrato JSON de escrita) ──────────
        if provider_config.id == "nvidia" or provider_id == "nvidia":
            keys = config_manager.get_nvidia_keys()
            if keys:
                # Camada 3 usa o modelo dedicado a código (settings), não a lista estática do provider
                model_pipeline = [settings.layer3_model, settings.layer3_fallback_model, "meta/llama-3.1-8b-instruct"]
                self.current_model = settings.layer3_model
                await self.broadcast_status()
                await self.broadcast_log(f"🟢 [NVIDIA NIM API] Executando via contrato JSON ({settings.layer3_model})...", "info")
                try:
                    result = await self._run_nvidia_worker(
                        task_id=task_id,
                        instrucao=instrucao,
                        model_pipeline=model_pipeline,
                        target_dir=target_dir,
                        allow_overwrite=allow_overwrite,
                        settings=settings,
                        profile_label="NVIDIA Pool",
                    )
                    if result["status"] == "success":
                        await self.broadcast_log(f"✅ Tarefa #{task_id} concluída via NVIDIA NIM API!", "success")
                    else:
                        await self.broadcast_log(f"⚠️ Tarefa #{task_id} falhou no contrato de escrita após Auto-Healing.", "warning")
                    self.is_busy = False
                    await self.broadcast_status()
                    return result
                except Exception as ne:
                    await self.broadcast_log(f"⚠️ [NVIDIA NIM] Erro: {ne}", "warning")

        # ─── EXECUÇÃO VIA CLI (antigravity / claude_code — tool use real) ────
        # claude_code é limitado a 1 execução simultânea via semáforo dedicado.
        claude_lock_held = False
        if provider_id == "claude_code" and self.claude_code_semaphore is not None:
            await self.broadcast_log("🔒 [Claude Code] Aguardando slot único (limite de 1 execução simultânea)...", "info")
            await self.claude_code_semaphore.acquire()
            claude_lock_held = True

        try:
            while attempt < total_attempts:
                attempt += 1
                await self.broadcast_status()
                await self.broadcast_log(f"🤖 [Tentativa {attempt}] Provedor: {provider_config.id} | Modelo: {modelo_selecionado} | Perfil: {current_profile.name}")

                # Isolamento Completo do Perfil no Windows
                custom_env = os.environ.copy()
                profile_path = current_profile.path.strip()
                drive, path_without_drive = os.path.splitdrive(profile_path)

                custom_env["USERPROFILE"] = profile_path
                custom_env["HOME"] = profile_path
                custom_env["HOMEDRIVE"] = drive if drive else "C:"
                custom_env["HOMEPATH"] = path_without_drive
                custom_env["LOCALAPPDATA"] = os.path.join(profile_path, "AppData", "Local")
                custom_env["APPDATA"] = os.path.join(profile_path, "AppData", "Roaming")
                custom_env["PYTHONIOENCODING"] = "utf-8"
                custom_env["PYTHONUTF8"] = "1"
                custom_env["SystemRoot"] = os.environ.get("SystemRoot", "C:\\Windows")
                custom_env["SystemDrive"] = os.environ.get("SystemDrive", "C:")
                custom_env["ComSpec"] = os.environ.get("ComSpec", "C:\\Windows\\System32\\cmd.exe")
                custom_env["PATHEXT"] = os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD")

                # Sanitizar quebras de linha e aspas para o cmd.exe do Windows não falhar
                clean_instruction = final_instruction.replace("\r\n", " ").replace("\n", " ").replace('"', "'")

                # Construir Comando Direto (RTK real quando settings.use_rtk)
                comando = provider_registry.build_command(
                    provider_id=provider_config.id,
                    instruction=clean_instruction,
                    model=modelo_selecionado,
                    skip_permissions=settings.skip_permissions,
                    use_rtk=settings.use_rtk
                )

                await self.broadcast_log(f"💻 Comando executado: {comando}", "command")

                try:
                    loop = asyncio.get_running_loop()

                    def run_sync_process():
                        import subprocess
                        import threading

                        proc = subprocess.Popen(
                            comando,
                            cwd=exec_cwd,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            text=True,
                            encoding="utf-8",
                            errors="replace",
                            env=custom_env,
                            shell=True
                        )

                        stdout_chunks = []
                        stderr_chunks = []

                        def read_out():
                            for line in iter(proc.stdout.readline, ""):
                                if line:
                                    stdout_chunks.append(line)
                                    asyncio.run_coroutine_threadsafe(self.broadcast_log(line.strip(), "stdout"), loop)
                            proc.stdout.close()

                        def read_err():
                            for line in iter(proc.stderr.readline, ""):
                                if line:
                                    stderr_chunks.append(line)
                                    asyncio.run_coroutine_threadsafe(self.broadcast_log(line.strip(), "error"), loop)
                            proc.stderr.close()

                        t1 = threading.Thread(target=read_out, daemon=True)
                        t2 = threading.Thread(target=read_err, daemon=True)
                        t1.start()
                        t2.start()

                        return_code = proc.wait()
                        t1.join()
                        t2.join()

                        return return_code, "".join(stdout_chunks), "".join(stderr_chunks)

                    returncode, stdout_text, stderr_text = await asyncio.to_thread(run_sync_process)
                    full_output = stdout_text + "\n" + stderr_text

                    # Detecção unificada de cota/erro (backend/error_detection.py)
                    is_quota_error = is_quota_or_error(full_output)

                    if is_quota_error or returncode != 0:
                        await self.broadcast_log(f"⚠️ [Aviso] Limite de cota ou erro detectado na tentativa {attempt}.", "warning")

                        # Failover para NVIDIA NIM (contrato JSON) após 2 falhas na CLI
                        if attempt >= 2 and config_manager.get_nvidia_keys():
                            await self.broadcast_log("🔄 [Failover Inteligente] Alternando para a API NVIDIA NIM (contrato JSON)...", "warning")
                            try:
                                model_pipeline = [settings.layer3_model, settings.layer3_fallback_model, "meta/llama-3.1-8b-instruct"]
                                result = await self._run_nvidia_worker(
                                    task_id=task_id,
                                    instrucao=instrucao,
                                    model_pipeline=model_pipeline,
                                    target_dir=target_dir,
                                    allow_overwrite=allow_overwrite,
                                    settings=settings,
                                    profile_label="NVIDIA Fallback",
                                )
                                if result["status"] == "success":
                                    await self.broadcast_log(f"✅ Tarefa #{task_id} concluída via NVIDIA NIM (Fallback)!", "success")
                                self.is_busy = False
                                await self.broadcast_status()
                                return result
                            except Exception as ne:
                                await self.broadcast_log(f"⚠️ [Fallback NVIDIA] Erro: {ne}", "warning")

                        if settings.auto_rotate_quota:
                            if models and modelo_selecionado in models:
                                curr_mod_idx = models.index(modelo_selecionado)
                                next_mod_idx = (curr_mod_idx + 1) % len(models)
                                modelo_selecionado = models[next_mod_idx]

                                if next_mod_idx == 0:
                                    current_profile = config_manager.rotate_profile()
                                    await self.broadcast_log(f"🔄 [Failover] Rotacionando conta física para: {current_profile.name}", "warning")
                            else:
                                current_profile = config_manager.rotate_profile()

                            self.current_profile = current_profile.name
                            self.current_model = modelo_selecionado
                            continue
                        else:
                            await self.broadcast_log("❌ Execução interrompida sem rotação.", "error")
                            self.is_busy = False
                            await self.broadcast_status()
                            approx_tokens = int(len(full_output) / 4) + int(len(final_instruction) / 4)
                            tokens_saved = int(approx_tokens * 0.35) if settings.use_caveman else 0
                            return {
                                "task_id": task_id,
                                "status": "failed",
                                "output": full_output,
                                "attempts": attempt,
                                "worker_id": self.worker_id,
                                "provider_id": provider_config.id,
                                "profile_name": current_profile.name,
                                "model": modelo_selecionado,
                                "use_caveman": settings.use_caveman,
                                "use_rtk": settings.use_rtk,
                                "approx_tokens": approx_tokens,
                                "tokens_saved": tokens_saved
                            }
                    else:
                        # Sucesso na CLI. Providers CLI têm tool use real de edição de arquivo —
                        # NÃO aplicamos o contrato JSON aqui (só capturamos/reportamos o que a CLI fez).
                        # (Removida a antiga varredura de palavras-chave em stdout de sucesso, que gerava
                        #  falso positivo de Auto-Healing sempre que o código legítimo continha 'error'/'exception'.)
                        await self.broadcast_log(f"✅ Tarefa #{task_id} concluída com sucesso!", "success")
                        self.is_busy = False
                        await self.broadcast_status()

                        approx_tokens = int(len(stdout_text) / 4) + int(len(final_instruction) / 4)
                        tokens_saved = int(approx_tokens * 0.35) if settings.use_caveman else 0
                        return {
                            "task_id": task_id,
                            "status": "success",
                            "output": stdout_text,
                            "attempts": attempt,
                            "worker_id": self.worker_id,
                            "provider_id": provider_config.id,
                            "profile_name": current_profile.name,
                            "model": modelo_selecionado,
                            "use_caveman": settings.use_caveman,
                            "use_rtk": settings.use_rtk,
                            "approx_tokens": approx_tokens,
                            "tokens_saved": tokens_saved
                        }

                except Exception as e:
                    import traceback
                    err_detail = traceback.format_exc()
                    print(f"[Worker Exception Detail]: {err_detail}")
                    await self.broadcast_log(f"❌ Erro ao disparar subprocesso do operário: {str(e)} | Details: {err_detail[:200]}", "error")
                    self.is_busy = False
                    await self.broadcast_status()
                    return {
                        "task_id": task_id,
                        "status": "error",
                        "output": err_detail,
                        "attempts": attempt,
                        "worker_id": self.worker_id,
                        "provider_id": provider_config.id,
                        "profile_name": current_profile.name if 'current_profile' in locals() else "Desconhecido",
                        "model": modelo_selecionado if 'modelo_selecionado' in locals() else "Padrão",
                        "use_caveman": settings.use_caveman,
                        "use_rtk": settings.use_rtk,
                        "approx_tokens": 0,
                        "tokens_saved": 0
                    }

            self.is_busy = False
            await self.broadcast_status()
            return {
                "task_id": task_id,
                "status": "failed",
                "output": "Esgotadas todas as tentativas de fallback para o provedor ativo.",
                "attempts": attempt
            }
        finally:
            # Libera o slot único do claude_code, independentemente do caminho de retorno
            if claude_lock_held:
                self.claude_code_semaphore.release()


class WorkerPool:
    def __init__(self, broadcaster_fn: Optional[Callable] = None):
        self.broadcaster_fn = broadcaster_fn
        # Semáforo dedicado ao claude_code (1 sessão OAuth simultânea). Compartilhado
        # por todos os workers para que o limite valha no pool inteiro, não por worker.
        self.claude_code_semaphore = asyncio.Semaphore(1)
        self.workers: List[TaskWorker] = []
        self._update_worker_count()

    def _update_worker_count(self):
        desired_count = config_manager.state.settings.max_workers
        while len(self.workers) < desired_count:
            w_id = f"Worker-{len(self.workers) + 1}"
            self.workers.append(TaskWorker(w_id, self.broadcaster_fn, self.claude_code_semaphore))
        while len(self.workers) > desired_count and not self.workers[-1].is_busy:
            self.workers.pop()

    def get_idle_worker(self) -> Optional[TaskWorker]:
        self._update_worker_count()
        for w in self.workers:
            if not w.is_busy:
                return w
        return None

    def get_workers_state(self) -> List[Dict[str, Any]]:
        self._update_worker_count()
        return [
            {
                "id": w.worker_id,
                "is_busy": w.is_busy,
                "provider": w.current_provider,
                "profile": w.current_profile or "Padrão",
                "model": w.current_model or "Padrão",
                "current_task": w.current_task_title if w.is_busy else "Aguardando tarefa..."
            }
            for w in self.workers
        ]
