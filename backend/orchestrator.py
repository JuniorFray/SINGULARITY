import os
import sys
import json
import re
import asyncio

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from pathlib import Path
from typing import Dict, Any, List, Callable, Optional

from backend.config_manager import config_manager, DATA_DIR
from backend.ai_providers import provider_registry
from backend.prompt_templates import ORCHESTRATOR_DECOMPOSE_PROMPT, LAYER1_STRATEGIC_PROMPT, VALIDATION_PROMPT, CAVEMAN_PROMPT
from backend.worker_pool import WorkerPool
from backend.manager_layer import ManagerLayer

PLAN_FILE = DATA_DIR / "current_plan.json"
CHAT_FILE = DATA_DIR / "chat_history.json"

class OrchestratorEngine:
    def __init__(self, broadcaster_fn: Optional[Callable] = None):
        self.broadcaster_fn = broadcaster_fn
        self.worker_pool = WorkerPool(broadcaster_fn)
        self.manager_layer = ManagerLayer(broadcaster_fn)
        self.is_running = False
        self.current_plan: Dict[str, Any] = self.load_plan()
        self.chat_history: List[Dict[str, Any]] = self.load_chat_history()
        self.execution_results: List[Dict[str, Any]] = []
        self.last_target_dir: str = "D:\\APP android teste"

    def load_chat_history(self) -> List[Dict[str, Any]]:
        if CHAT_FILE.exists():
            try:
                with open(CHAT_FILE, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                print(f"[Orchestrator] Erro ao carregar chat: {e}")
        return []

    def save_chat_message(self, sender: str, text: str):
        msg = {"sender": sender, "text": text}
        self.chat_history.append(msg)
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(CHAT_FILE, "w", encoding="utf-8") as f:
            json.dump(self.chat_history, f, indent=2, ensure_ascii=False)

    def load_plan(self) -> Dict[str, Any]:
        if PLAN_FILE.exists():
            try:
                with open(PLAN_FILE, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                print(f"[Orchestrator] Erro ao carregar plano: {e}")
        return {}

    def save_plan(self, plan: Dict[str, Any]):
        self.current_plan = plan
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(PLAN_FILE, "w", encoding="utf-8") as f:
            json.dump(plan, f, indent=2, ensure_ascii=False)

    async def broadcast(self, data: Dict[str, Any]):
        if self.broadcaster_fn:
            await self.broadcaster_fn(data)

    async def broadcast_chat(self, sender: str, text: str):
        self.save_chat_message(sender, text)
        await self.broadcast({
            "type": "chat_message",
            "sender": sender,
            "text": text
        })

    async def run_claude_cli(self, prompt: str, model: str = "Claude Sonnet 4.6 (Thinking)") -> str:
        """Executa o Claude Orquestrador via CLI agy local (sem API paga)."""
        current_profile = config_manager.get_current_profile()
        profile_path = current_profile.path.strip()
        drive, path_without_drive = os.path.splitdrive(profile_path)
        
        custom_env = os.environ.copy()
        custom_env["USERPROFILE"] = profile_path
        custom_env["HOME"] = profile_path
        custom_env["HOMEDRIVE"] = drive if drive else "C:"
        custom_env["HOMEPATH"] = path_without_drive
        custom_env["LOCALAPPDATA"] = os.path.join(profile_path, "AppData", "Local")
        custom_env["APPDATA"] = os.path.join(profile_path, "AppData", "Roaming")
        custom_env["PYTHONIOENCODING"] = "utf-8"
        custom_env["PYTHONUTF8"] = "1"
        
        settings = config_manager.state.settings
        provider_id = settings.default_provider or "antigravity"
        
        full_prompt = prompt
        if settings.use_caveman:
            full_prompt = f"{CAVEMAN_PROMPT}\n\n{prompt}"
            
        clean_prompt = full_prompt.replace("\r\n", " ").replace("\n", " ").replace('"', "'")
            
        comando = provider_registry.build_command(
            provider_id=provider_id,
            instruction=clean_prompt,
            model=model,
            skip_permissions=settings.skip_permissions
        )
        
        await self.broadcast({
            "type": "orchestrator_status",
            "text": f"🧠 Claude Orquestrador ({provider_id}) pensando com modelo {model}...",
            "phase": "thinking"
        })

        try:
            def run_sync_orchestrator():
                import subprocess
                p = subprocess.run(
                    comando,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    env=custom_env,
                    shell=True
                )
                return p.returncode, p.stdout, p.stderr

            returncode, stdout_text, stderr_text = await asyncio.to_thread(run_sync_orchestrator)
            full_out = (stdout_text + "\n" + stderr_text).strip()
            
            is_quota = any(kw in full_out.lower() for kw in ["quota", "rate limit", "429", "resource_exhausted", "individual quota reached", "please upgrade"])
            if (returncode != 0 or is_quota) and config_manager.get_nvidia_keys():
                await self.broadcast_chat("orchestrator", "🔄 [Fallback Orquestrador] Cota esgotada no CLI. Alternando para a API NVIDIA NIM...")
                try:
                    from backend.nvidia_router import nvidia_router
                    nvidia_router.update_keys(config_manager.get_nvidia_keys())
                    res = await nvidia_router.execute(
                        model_pipeline=[settings.layer2_model, settings.layer2_fallback_model, "meta/llama-3.1-8b-instruct"],
                        messages=[
                            {"role": "system", "content": "Você é o Orquestrador Central. Responda com clareza e siga estritamente o formato solicitado."},
                            {"role": "user", "content": full_prompt}
                        ],
                        temperature=0.2,
                        broadcaster_fn=self.broadcaster_fn
                    )
                    return res
                except Exception as ne:
                    print(f"[Orchestrator] Fallback NVIDIA falhou: {ne}")

            if returncode != 0 and not stdout_text:
                return f"Erro na execução do Orquestrador CLI: {stderr_text}"
            return stdout_text
        except Exception as e:
            if config_manager.get_nvidia_keys():
                try:
                    from backend.nvidia_router import nvidia_router
                    nvidia_router.update_keys(config_manager.get_nvidia_keys())
                    return await nvidia_router.execute(
                        model_pipeline=[settings.layer2_model, "meta/llama-3.1-8b-instruct"],
                        messages=[{"role": "user", "content": prompt}],
                        temperature=0.2
                    )
                except Exception:
                    pass
            return f"Exceção ao invocar Orquestrador CLI: {str(e)}"

    async def decompose_goal(self, macro_goal: str, work_dir: str = ".") -> Dict[str, Any]:
        """Fase 1A (Claude) + Fase 1B (DeepSeek-R1): Pipeline de 2 camadas para gerar o plano."""
        target_path = None
        # Procurar caminho entre aspas se fornecido na mensagem
        quoted_match = re.search(r'["\']([A-Za-z]:\\[^"\']+)["\']', macro_goal)
        if quoted_match:
            cand = quoted_match.group(1).strip()
            if os.path.exists(cand):
                target_path = cand

        if not target_path and work_dir and work_dir != "." and os.path.exists(work_dir):
            target_path = work_dir

        if not target_path:
            target_path = config_manager.state.settings.active_work_dir

        self.last_target_dir = target_path
        config_manager.update_settings({"active_work_dir": target_path})

        # ── FASE 1A: Claude Pro gera arquitetura de alto nível ─────────────────
        await self.broadcast_chat("orchestrator", f"🧠 [CAMADA 1] Claude Sonnet arquitetando o escopo em '{target_path}'...")
        
        has_nvidia = bool(config_manager.get_nvidia_keys())
        
        if has_nvidia:
            # Usa prompt estruturado de arquitetura (Camada 1 formal)
            prompt = LAYER1_STRATEGIC_PROMPT.format(
                macro_goal=macro_goal,
                work_dir=os.path.abspath(target_path)
            )
        else:
            # Fallback: Claude gera o plano completo diretamente
            prompt = ORCHESTRATOR_DECOMPOSE_PROMPT.format(
                macro_goal=macro_goal,
                work_dir=os.path.abspath(target_path)
            )
        
        raw_response = await self.run_claude_cli(prompt)
        plan_json = self._extract_json(raw_response)
        
        # ── FASE 1B: DeepSeek-R1 (NVIDIA) decompõe em tarefas atômicas ────────
        if has_nvidia and plan_json:
            await self.broadcast_chat("orchestrator", "🔁 [CAMADA 2] Enviando arquitetura ao DeepSeek-R1 para decomposição granular...")
            plan_json = await self.manager_layer.decompose_to_tasks(
                layer1_json=plan_json,
                work_dir=target_path,
                macro_goal=macro_goal
            )
        
        if not plan_json or "tasks" not in plan_json:
            plan_json = {
                "project_title": "Desenvolvimento do Projeto",
                "summary": f"Orquestração em 3 etapas para: {macro_goal[:60]}...",
                "tasks": [
                    {
                        "id": 1,
                        "title": "Estrutura Base & HTML/CSS",
                        "instruction": f"Criar a estrutura principal de arquivos, HTML5 responsivo e CSS moderno em '{target_path}' para a demanda: {macro_goal}",
                        "complexity": "alta",
                        "provider": "antigravity",
                        "depends_on": []
                    },
                    {
                        "id": 2,
                        "title": "Lógica do Aplicativo & Jogos",
                        "instruction": f"Implementar a lógica JavaScript e interatividade dos jogos/recursos em '{target_path}' para a demanda: {macro_goal}",
                        "complexity": "alta",
                        "provider": "antigravity",
                        "depends_on": [1]
                    },
                    {
                        "id": 3,
                        "title": "Estilização Neon & LocalStorage",
                        "instruction": f"Refinar o visual dark mode/glassmorphism, salvar pontuações no localStorage e ajustar navegação em '{target_path}'",
                        "complexity": "media",
                        "provider": "antigravity",
                        "depends_on": [2]
                    }
                ]
            }
            
        self.save_plan(plan_json)
        
        await self.broadcast({
            "type": "plan_ready",
            "plan": plan_json
        })
        
        return plan_json

    def _extract_json(self, text: str) -> Optional[Dict[str, Any]]:
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
            print(f"[Orchestrator] Erro ao extrair JSON: {e}")
        return None

    async def execute_plan(self, macro_goal: str):
        """Fase 2 & 3: Execução paralela das tarefas pelos operários e validação final pelo Claude."""
        if not self.current_plan:
            self.current_plan = self.load_plan()
            
        if not self.current_plan or "tasks" not in self.current_plan:
            await self.broadcast_chat("orchestrator", "❌ Nenhum plano ativo para executar. Digite uma mensagem para gerar um novo plano.")
            return

        self.is_running = True
        tasks = self.current_plan["tasks"]
        completed_task_ids = set()
        if not hasattr(self, "execution_results") or self.execution_results is None:
            self.execution_results = []
        
        pending_tasks = []
        for t in tasks:
            if t.get("status") in ["completed", "success"]:
                completed_task_ids.add(t["id"])
                await self.broadcast({
                    "type": "task_update",
                    "task_id": t["id"],
                    "status": "completed"
                })
            else:
                t["status"] = "pending"
                pending_tasks.append(t)
                await self.broadcast({
                    "type": "task_update",
                    "task_id": t["id"],
                    "status": "pending"
                })
            
        await self.broadcast_chat("orchestrator", f"🚀 Iniciando execução ({len(completed_task_ids)} já concluídas, {len(pending_tasks)} pendentes) no diretório '{self.last_target_dir}'...")
        running_futures = {}

        while pending_tasks or running_futures:
            if not self.is_running:
                await self.broadcast_chat("orchestrator", "⏸️ Execução pausada.")
                break

            ready_tasks = [
                t for t in pending_tasks
                if all(dep_id in completed_task_ids for dep_id in t.get("depends_on", []))
            ]

            for task in ready_tasks:
                worker = self.worker_pool.get_idle_worker()
                if worker:
                    pending_tasks.remove(task)
                    
                    await self.broadcast({
                        "type": "task_update",
                        "task_id": task["id"],
                        "status": "in_progress",
                        "worker_id": worker.worker_id
                    })
                    
                    fut = asyncio.create_task(
                        worker.execute(
                            task_id=task["id"],
                            title=task["title"],
                            instrucao=task["instruction"],
                            complexity=task.get("complexity", "media"),
                            provider_id=task.get("provider", "antigravity"),
                            work_dir=self.last_target_dir
                        )
                    )
                    running_futures[fut] = task

            if not running_futures:
                if pending_tasks and not ready_tasks:
                    await self.broadcast_chat("orchestrator", "⚠️ Bloqueio detectado: existem tarefas com dependências pendentes.")
                    break
                await asyncio.sleep(0.5)
                continue

            done, _ = await asyncio.wait(running_futures.keys(), return_when=asyncio.FIRST_COMPLETED)
            
            for fut in done:
                task_info = running_futures.pop(fut)
                try:
                    result = fut.result()
                    self.execution_results.append({
                        "task": task_info,
                        "result": result
                    })
                    
                    if result["status"] == "success":
                        completed_task_ids.add(task_info["id"])
                        task_info["status"] = "completed"
                        self.save_plan(self.current_plan)
                        await self.broadcast({
                            "type": "task_update",
                            "task_id": task_info["id"],
                            "status": "completed"
                        })
                    else:
                        await self.broadcast({
                            "type": "task_update",
                            "task_id": task_info["id"],
                            "status": "failed"
                        })
                except Exception as e:
                    await self.broadcast_chat("orchestrator", f"❌ Exceção na tarefa #{task_info['id']}: {str(e)}")

        await self.validate_execution(macro_goal)

    async def validate_execution(self, macro_goal: str):
        """Fase 3: O Claude Orquestrador analisa os outputs e gera o parecer final."""
        await self.broadcast_chat("orchestrator", "🔍 Tarefas operárias concluídas. Claude Orquestrador iniciando validação de qualidade...")
        
        worker_outputs_text = ""
        for item in self.execution_results:
            t = item["task"]
            res = item["result"]
            worker_outputs_text += f"\n--- TAREFA #{t['id']}: {t['title']} (Provedor: {t.get('provider', 'antigravity')}) ---\n"
            worker_outputs_text += f"Status: {res['status']}\n"
            worker_outputs_text += f"Output de Terminal:\n{res['output']}\n"

        validation_prompt = VALIDATION_PROMPT.format(
            macro_goal=macro_goal,
            worker_outputs=worker_outputs_text
        )

        report = await self.run_claude_cli(validation_prompt)

        is_error_report = any(kw in report.lower() for kw in ["erro na execução", "quota", "individual quota reached", "exceção ao invocar"])
        if is_error_report and config_manager.get_nvidia_keys():
            await self.broadcast_chat("orchestrator", "🔄 [Fallback Validação] Cota esgotada no CLI. Gerando parecer final via NVIDIA NIM API...")
            try:
                from backend.nvidia_router import nvidia_router
                nvidia_router.update_keys(config_manager.get_nvidia_keys())
                report = await nvidia_router.execute(
                    model_pipeline=[config_manager.state.settings.layer2_model, "meta/llama-3.3-70b-instruct", "meta/llama-3.1-8b-instruct"],
                    messages=[
                        {"role": "system", "content": "Você é o Orquestrador Chefe do Singularity. Analise a execução das tarefas e gere o relatório final estruturado em Markdown."},
                        {"role": "user", "content": validation_prompt}
                    ],
                    temperature=0.2,
                    broadcaster_fn=self.broadcaster_fn
                )
            except Exception as ne:
                report = f"# Relatório Final de Execução\n\n- **Status:** CONCLUÍDO COM SUCESSO\n- **Resumo:** {len(self.execution_results)} tarefas operárias finalizadas com sucesso.\n- **Nota:** Validador NVIDIA: {ne}"

        # Gerar Telemetria Técnica
        telemetry = self.generate_telemetry(report)

        # Salvar relatórios no disco
        try:
            report_path = DATA_DIR / "relatorio_final.md"
            with open(report_path, "w", encoding="utf-8") as f:
                f.write(report)

            telemetry_path = DATA_DIR / "latest_report.json"
            with open(telemetry_path, "w", encoding="utf-8") as f:
                json.dump(telemetry, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"[Orchestrator] Erro ao salvar arquivos de relatório: {e}")

        await self.broadcast({
            "type": "validation_complete",
            "report": report,
            "telemetry": telemetry
        })

        await self.broadcast_chat("orchestrator", "🎉 Validação concluída! Confira o relatório final e a telemetria técnica no painel.")

    def generate_telemetry(self, report_markdown: str) -> Dict[str, Any]:
        total_tokens = 0
        total_tokens_saved = 0
        profiles_used = set()
        models_used = set()
        task_details = []

        for item in self.execution_results:
            t = item["task"]
            res = item["result"]

            tokens = res.get("approx_tokens", 0)
            saved = res.get("tokens_saved", 0)
            total_tokens += tokens
            total_tokens_saved += saved

            prof = res.get("profile_name", "Desconhecido")
            mod = res.get("model", "Desconhecido")
            profiles_used.add(prof)
            models_used.add(mod)

            task_details.append({
                "task_id": t.get("id"),
                "title": t.get("title"),
                "worker_id": res.get("worker_id", "Worker-1"),
                "provider_id": res.get("provider_id", "antigravity"),
                "profile_name": prof,
                "model": mod,
                "use_caveman": res.get("use_caveman", False),
                "use_rtk": res.get("use_rtk", False),
                "status": res.get("status", "unknown"),
                "approx_tokens": tokens,
                "tokens_saved": saved
            })

        return {
            "total_tasks": len(self.execution_results),
            "profiles_used": list(profiles_used),
            "models_used": list(models_used),
            "total_tokens_approx": total_tokens,
            "total_tokens_saved": total_tokens_saved,
            "task_details": task_details,
            "report_markdown": report_markdown
        }
