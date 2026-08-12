import os
import sys
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
from backend.prompt_templates import CAVEMAN_PROMPT

def apply_ai_output_to_filesystem(title: str, instruction: str, output_text: str, work_dir: str) -> List[str]:
    """
    Analisa a resposta do modelo IA (NVIDIA NIM API) e aplica fisicamente
    as alterações (criação de pastas, escrita/edição de arquivos) no disco.
    Retorna a lista de arquivos afetados.
    """
    if not work_dir:
        return []

    import re
    affected_files = []

    # 1. Processar comandos `mkdir`
    mkdir_matches = re.findall(r'mkdir\s+(?:-p\s+)?["\']?([A-Za-z]:\\[^"\'\r\n]+|[\w\-\.\/\\]+)["\']?', output_text, re.IGNORECASE)
    for folder in mkdir_matches:
        folder_path = folder.strip()
        if not os.path.isabs(folder_path):
            folder_path = os.path.join(work_dir, folder_path)
        try:
            os.makedirs(folder_path, exist_ok=True)
            print(f"[Worker FileSystem] Pasta criada: {folder_path}")
        except Exception as e:
            print(f"[Worker FileSystem] Erro ao criar pasta {folder_path}: {e}")

    # 2. Detectar arquivo alvo da instrução ou título
    target_from_instruction = None
    file_match = re.search(r'([a-zA-Z0-9_\-\/\\]+\.(?:html|css|js|json|py|md|ts))', instruction + " " + title, re.IGNORECASE)
    if file_match:
        cand = file_match.group(1).strip()
        if os.path.isabs(cand):
            target_from_instruction = cand
        else:
            target_from_instruction = os.path.join(work_dir, cand)
    else:
        # Heurística inteligente quando o título não tem extensão explícita (ex: 'Create GameOptionA HTML file')
        combo_text = (title + " " + instruction).lower()
        game_match = re.search(r'(game\s*option\s*[a-z0-9_]+|option\s*[a-z0-9_]+)', combo_text)
        if game_match:
            raw_gname = game_match.group(1).replace(" ", "_").strip()
            # Normalizar para pasta do jogo (ex: games/optionA/optionA.html)
            clean_gname = raw_gname.replace("game_", "").replace("gameoption", "option")
            ext = ".js"
            if "html" in combo_text:
                ext = ".html"
            elif "css" in combo_text or "style" in combo_text:
                ext = ".css"
            target_from_instruction = os.path.join(work_dir, "games", clean_gname, f"{clean_gname}{ext}")
        elif "app.js" in combo_text or "screen definitions" in combo_text or "navigation logic" in combo_text:
            target_from_instruction = os.path.join(work_dir, "app.js")
        elif "index.html" in combo_text or "hub" in combo_text or "button" in combo_text:
            target_from_instruction = os.path.join(work_dir, "index.html")
        elif "style.css" in combo_text:
            target_from_instruction = os.path.join(work_dir, "style.css")

    # 3. Processar blocos de código ```lang ... ```
    code_blocks = re.findall(r'```([a-zA-Z0-9_\-]+)?\s*\n(.*?)\n```', output_text, re.DOTALL)
    for lang, block in code_blocks:
        code_content = block.strip()
        lang_str = (lang or "").lower()
        # Ignorar blocos de terminal/bash para não sobrescrever código com comandos de shell
        if lang_str in ["bash", "sh", "shell", "powershell", "cmd", "terminal", "zsh", "console"]:
            continue
        if not code_content or any(code_content.startswith(cmd) for cmd in ["mkdir", "ls ", "dir ", "cd ", "rm ", "git "]):
            continue

        # Procura caminho no comentário da 1ª linha do código
        path_header_match = re.search(r'^(?://|/\*|<!--|#)\s*([A-Za-z]:\\[^\r\n]+|[\w\-\.\/\\]+\.(?:html|css|js|json|py|md|ts))', code_content)
        
        target_path = None
        if path_header_match:
            cand = path_header_match.group(1).strip()
            if os.path.isabs(cand):
                target_path = cand
            else:
                target_path = os.path.join(work_dir, cand)
        elif target_from_instruction:
            target_path = target_from_instruction

        if target_path:
            try:
                os.makedirs(os.path.dirname(target_path), exist_ok=True)
                with open(target_path, "w", encoding="utf-8") as f:
                    f.write(code_content)
                affected_files.append(target_path)
                print(f"[Worker FileSystem] Arquivo gravado com sucesso: {target_path}")
            except Exception as e:
                print(f"[Worker FileSystem] Erro ao gravar {target_path}: {e}")

    return affected_files

class TaskWorker:
    def __init__(self, worker_id: str, broadcaster_fn: Optional[Callable] = None):
        self.worker_id = worker_id
        self.broadcaster_fn = broadcaster_fn
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

    async def execute(
        self,
        task_id: int,
        title: str,
        instrucao: str,
        complexity: str,
        provider_id: str = "antigravity",
        work_dir: Optional[str] = None
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

        final_instruction = instrucao
        if settings.use_caveman:
            final_instruction = f"{CAVEMAN_PROMPT}\n\nTAREFA: {instrucao}"
            await self.broadcast_log("🦴 [Otimização] Modo Caveman aplicado ao prompt.")

        target_dir = work_dir if (work_dir and os.path.exists(work_dir)) else config_manager.state.settings.active_work_dir
        exec_cwd = target_dir if (target_dir and os.path.exists(target_dir)) else None

        # ─── EXECUÇÃO DIRETA VIA NVIDIA NIM API (HTTP) ──────────────────────
        if provider_config.id == "nvidia" or provider_id == "nvidia":
            from backend.nvidia_router import nvidia_router
            keys = config_manager.get_nvidia_keys()
            if keys:
                nvidia_router.update_keys(keys)
                await self.broadcast_log(f"🟢 [NVIDIA NIM API] Executando via API HTTP ({modelo_selecionado})...", "info")
                try:
                    res_text = await nvidia_router.execute(
                        model_pipeline=[modelo_selecionado, settings.layer3_fallback_model, "meta/llama-3.1-8b-instruct"],
                        messages=[
                            {"role": "system", "content": "Você é um operário técnico especialista. Execute a instrução diretamente."},
                            {"role": "user", "content": final_instruction}
                        ],
                        temperature=0.2,
                        broadcaster_fn=self.broadcaster_fn
                    )
                    await self.broadcast_log(res_text, "stdout")
                    
                    # Aplicar alterações no sistema de arquivos
                    affected = apply_ai_output_to_filesystem(title, instrucao, res_text, target_dir)
                    if affected:
                        await self.broadcast_log(f"📁 [FileSystem] {len(affected)} arquivo(s) gravado(s) em '{target_dir}'.", "info")

                    await self.broadcast_log(f"✅ Tarefa #{task_id} concluída via NVIDIA NIM API!", "success")
                    self.is_busy = False
                    await self.broadcast_status()
                    return {
                        "task_id": task_id,
                        "status": "success",
                        "output": res_text,
                        "attempts": 1,
                        "worker_id": self.worker_id,
                        "provider_id": "nvidia",
                        "profile_name": "NVIDIA Pool",
                        "model": modelo_selecionado,
                        "use_caveman": settings.use_caveman,
                        "use_rtk": settings.use_rtk,
                        "approx_tokens": int(len(res_text) / 4),
                        "tokens_saved": 0
                    }
                except Exception as ne:
                    await self.broadcast_log(f"⚠️ [NVIDIA NIM] Erro: {ne}", "warning")

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
            
            # Construir Comando Direto
            cmd_body = provider_registry.build_command(
                provider_id=provider_config.id,
                instruction=clean_instruction,
                model=modelo_selecionado,
                skip_permissions=settings.skip_permissions
            )
            
            # Execução Direta do Binário CLI
            comando = cmd_body
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

                is_quota_error = any(kw in full_output.lower() for kw in [
                    "quota", "rate limit", "429", "resource_exhausted", 
                    "limit reached", "invalid model", "not recognized", "timeout waiting",
                    "not logged in", "please run /login", "login required"
                ])

                if is_quota_error or returncode != 0:
                    await self.broadcast_log(f"⚠️ [Aviso] Limite de cota ou erro detectado na tentativa {attempt}.", "warning")

                    # Fallback Inteligente para NVIDIA NIM após 2 falhas na CLI
                    if attempt >= 2 and config_manager.get_nvidia_keys():
                        await self.broadcast_log("🔄 [Failover Inteligente] Alternando para a API NVIDIA NIM devido a limites na CLI...", "warning")
                        try:
                            from backend.nvidia_router import nvidia_router
                            nvidia_router.update_keys(config_manager.get_nvidia_keys())
                            res_text = await nvidia_router.execute(
                                model_pipeline=[settings.layer3_model, settings.layer3_fallback_model, "meta/llama-3.1-8b-instruct"],
                                messages=[
                                    {"role": "system", "content": "Você é um operário técnico especialista. Execute a instrução diretamente."},
                                    {"role": "user", "content": final_instruction}
                                ],
                                temperature=0.2,
                                broadcaster_fn=self.broadcaster_fn
                            )
                            await self.broadcast_log(res_text, "stdout")
                            
                            affected = apply_ai_output_to_filesystem(title, instrucao, res_text, target_dir)
                            if affected:
                                await self.broadcast_log(f"📁 [FileSystem] {len(affected)} arquivo(s) gravado(s) em '{target_dir}'.", "info")

                            await self.broadcast_log(f"✅ Tarefa #{task_id} concluída com sucesso via NVIDIA NIM (Fallback)! ", "success")
                            self.is_busy = False
                            await self.broadcast_status()
                            return {
                                "task_id": task_id,
                                "status": "success",
                                "output": res_text,
                                "attempts": attempt,
                                "worker_id": self.worker_id,
                                "provider_id": "nvidia",
                                "profile_name": "NVIDIA Fallback",
                                "model": settings.layer3_model,
                                "use_caveman": settings.use_caveman,
                                "use_rtk": settings.use_rtk,
                                "approx_tokens": int(len(res_text) / 4),
                                "tokens_saved": 0
                            }
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
                        # Calcular estimativa de tokens e economia
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
                    # ─── AUTO-HEALING: captura erros no stdout e tenta corrigir via NVIDIA ───
                    error_keywords = ["syntaxerror", "nameerror", "typeerror", "assertionerror", 
                                      "traceback", "exception", "error:", "failed:", "cannot find"]
                    has_error_in_output = any(kw in stdout_text.lower() for kw in error_keywords)
                    
                    if has_error_in_output and config_manager.get_nvidia_keys():
                        healing_attempts = getattr(self, '_healing_attempts', 0)
                        max_healing = settings.auto_healing_max_attempts
                        
                        if healing_attempts < max_healing:
                            self._healing_attempts = healing_attempts + 1
                            await self.broadcast_log(
                                f"🔧 [Auto-Healing {self._healing_attempts}/{max_healing}] Erro detectado no output. Enviando ao DeepSeek-R1 para correção...",
                                "warning"
                            )
                            try:
                                from backend.nvidia_router import nvidia_router
                                nvidia_router.update_keys(config_manager.get_nvidia_keys())
                                healing_instruction = await nvidia_router.execute_auto_healing(
                                    error_context=stdout_text[-3000:],
                                    broken_code=instrucao,
                                    broadcaster_fn=self.broadcaster_fn
                                )
                                await self.broadcast_log(f"💡 [Auto-Healing] Instrução corretiva: {healing_instruction[:300]}...", "info")
                                # Reexecutar com a instrução corretiva
                                final_instruction = f"{CAVEMAN_PROMPT}\n\nTAREFA DE CORREÇÃO: {healing_instruction}\n\nContexto do erro original:\n{stdout_text[-1000:]}"
                                attempt -= 1  # Não conta como nova tentativa de failover
                                continue
                            except Exception as he:
                                await self.broadcast_log(f"⚠️ [Auto-Healing] Falha no serviço de correção: {he}", "warning")
                        else:
                            self._healing_attempts = 0  # Reset para próxima tarefa
                    else:
                        self._healing_attempts = 0

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

class WorkerPool:
    def __init__(self, broadcaster_fn: Optional[Callable] = None):
        self.broadcaster_fn = broadcaster_fn
        self.workers: List[TaskWorker] = []
        self._update_worker_count()

    def _update_worker_count(self):
        desired_count = config_manager.state.settings.max_workers
        while len(self.workers) < desired_count:
            w_id = f"Worker-{len(self.workers) + 1}"
            self.workers.append(TaskWorker(w_id, self.broadcaster_fn))
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
