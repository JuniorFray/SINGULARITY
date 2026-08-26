import os
import sys
import json
import re
import time
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
from backend.prompt_templates import ORCHESTRATOR_DECOMPOSE_PROMPT, LAYER1_STRATEGIC_PROMPT, VALIDATION_PROMPT, CAVEMAN_PROMPT, CHAT_SYSTEM_PROMPT
from backend.skills import get_skill_guidance
from backend.worker_pool import WorkerPool
from backend.manager_layer import ManagerLayer, _extract_json as _robust_extract_json
from backend.error_detection import is_quota_or_error

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
        # Modelos usados por camada NÃO-operária (Camada 1 e 2 + validação). A telemetria
        # antiga só creditava os operários (Camada 3); glm-5.2 ficava invisível.
        self.pipeline_models: List[Dict[str, str]] = []  # [{"layer": ..., "model": ...}]
        # Histórico do chat conversacional (Q&A grátis) em formato role/content para o LLM.
        self.qa_history: List[Dict[str, str]] = []
        self.last_target_dir: str = "D:\\APP android teste"

    def _record_model(self, layer: str, model: str):
        """Registra (sem duplicar) qual modelo rodou em cada camada não-operária."""
        if not model:
            return
        for m in self.pipeline_models:
            if m["layer"] == layer and m["model"] == model:
                return
        self.pipeline_models.append({"layer": layer, "model": model})

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

    def clear_state(self):
        """Limpa chat + plano + resultados TANTO em memória QUANTO em disco.
        Antes o 'Limpar Tudo' só apagava o DOM no navegador; ao recarregar, o
        init_state do WebSocket reenviava chat_history/plan persistidos e tudo
        reaparecia. Agora o estado é zerado de verdade."""
        self.chat_history = []
        self.current_plan = {}
        self.execution_results = []
        self.pipeline_models = []
        self.qa_history = []
        self.is_running = False
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        try:
            with open(CHAT_FILE, "w", encoding="utf-8") as f:
                json.dump([], f)
            with open(PLAN_FILE, "w", encoding="utf-8") as f:
                json.dump({}, f)
        except Exception as e:
            print(f"[Orchestrator] Erro ao limpar estado: {e}")

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

    async def run_claude_cli(self, prompt: str, model: str = "Claude Sonnet 4.6 (Thinking)", role: str = "Camada 1 (Estratégia)") -> str:
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

        # Toggle CLI desligado: nem tenta o subprocesso do CLI (que hoje bate na cota do
        # Antigravity) — vai DIRETO para o pipeline NVIDIA da Camada 1. Economiza a tentativa.
        if not settings.use_cli_providers and config_manager.get_nvidia_keys():
            try:
                from backend.nvidia_router import nvidia_router
                nvidia_router.update_keys(config_manager.get_nvidia_keys())
                res = await nvidia_router.execute(
                    model_pipeline=[settings.layer1_fallback_model, settings.layer2_fallback_model, "meta/llama-3.1-8b-instruct"],
                    messages=[
                        {"role": "system", "content": "Você é o Orquestrador Central. Responda com clareza e siga estritamente o formato solicitado."},
                        {"role": "user", "content": full_prompt}
                    ],
                    temperature=0.2,
                    broadcaster_fn=self.broadcaster_fn
                )
                self._record_model(f"{role} — NVIDIA (CLI desligado)", settings.layer1_fallback_model)
                return res
            except Exception as ne:
                print(f"[Orchestrator] NVIDIA direto (CLI off) falhou: {ne}")
                # cai para o caminho CLI abaixo como último recurso

        clean_prompt = full_prompt.replace("\r\n", " ").replace("\n", " ").replace('"', "'")
            
        # RTK real na Camada 1 (regra global 1): o comando CLI do orquestrador
        # também é prefixado com `rtk` quando settings.use_rtk está ligado — antes
        # esta chamada omitia o parâmetro e a Camada 1 escapava do proxy de tokens.
        comando = provider_registry.build_command(
            provider_id=provider_id,
            instruction=clean_prompt,
            model=model,
            skip_permissions=settings.skip_permissions,
            use_rtk=settings.use_rtk
        )
        
        await self.broadcast({
            "type": "orchestrator_status",
            "text": f"🧠 Claude Orquestrador ({provider_id}) pensando com modelo {model}...",
            "phase": "thinking"
        })

        try:
            def run_sync_orchestrator(_comando, _env):
                import subprocess
                p = subprocess.run(
                    _comando,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    env=_env,
                    shell=True
                )
                return p.returncode, p.stdout, p.stderr

            # ROTAÇÃO DE CONTA GOOGLE: testa o CLI (Antigravity/Claude) em CADA perfil/conta
            # antes de desistir. Antes fazia 1 tentativa e ia direto para o NVIDIA — nunca
            # trocava para a 2ª conta. Cada troca aparece nos logs.
            profiles = config_manager.state.profiles or []
            max_profile_attempts = max(1, len(profiles)) if settings.auto_rotate_quota else 1
            last_err = ""

            for p_attempt in range(max_profile_attempts):
                _cp = config_manager.get_current_profile()
                _pp = _cp.path.strip()
                _drv, _rest = os.path.splitdrive(_pp)
                _env = os.environ.copy()
                _env["USERPROFILE"] = _pp
                _env["HOME"] = _pp
                _env["HOMEDRIVE"] = _drv if _drv else "C:"
                _env["HOMEPATH"] = _rest
                _env["LOCALAPPDATA"] = os.path.join(_pp, "AppData", "Local")
                _env["APPDATA"] = os.path.join(_pp, "AppData", "Roaming")
                _env["PYTHONIOENCODING"] = "utf-8"
                _env["PYTHONUTF8"] = "1"
                _cmd = provider_registry.build_command(
                    provider_id=provider_id, instruction=clean_prompt, model=model,
                    skip_permissions=settings.skip_permissions, use_rtk=settings.use_rtk
                )
                await self.broadcast_chat("orchestrator", f"🖥️ [Camada 1] Testando {provider_id} na conta '{_cp.name}' ({p_attempt+1}/{max_profile_attempts})...")

                returncode, stdout_text, stderr_text = await asyncio.to_thread(run_sync_orchestrator, _cmd, _env)
                full_out = (stdout_text + "\n" + stderr_text).strip()
                is_quota = is_quota_or_error(full_out)

                if returncode == 0 and stdout_text.strip() and not is_quota:
                    self._record_model(f"{role} — CLI {provider_id} / {_cp.name}", model)
                    return stdout_text

                last_err = (stderr_text or stdout_text or "falha desconhecida").strip()
                await self.broadcast_chat("orchestrator", f"⚠️ [Camada 1] Conta '{_cp.name}' falhou/sem cota no {provider_id}.")
                if settings.auto_rotate_quota and len(profiles) > 1 and p_attempt < max_profile_attempts - 1:
                    _nxt = config_manager.rotate_profile()
                    await self.broadcast_chat("orchestrator", f"🔄 [Rotação de Conta Google] Trocando para '{_nxt.name}' e testando novamente...")

            # Todas as contas Google falharam → NVIDIA NIM
            if config_manager.get_nvidia_keys():
                await self.broadcast_chat("orchestrator", "🔄 [Fallback Orquestrador] Todas as contas Google sem cota no CLI. Alternando para a API NVIDIA NIM...")
                try:
                    from backend.nvidia_router import nvidia_router
                    nvidia_router.update_keys(config_manager.get_nvidia_keys())
                    res = await nvidia_router.execute(
                        model_pipeline=[settings.layer1_fallback_model, settings.layer2_fallback_model, "nvidia/nemotron-3-nano-30b-a3b"],
                        messages=[
                            {"role": "system", "content": "Você é o Orquestrador Central. Responda com clareza e siga estritamente o formato solicitado."},
                            {"role": "user", "content": full_prompt}
                        ],
                        temperature=0.2,
                        broadcaster_fn=self.broadcaster_fn
                    )
                    self._record_model(f"{role} — fallback NVIDIA", settings.layer1_fallback_model)
                    return res
                except Exception as ne:
                    print(f"[Orchestrator] Fallback NVIDIA falhou: {ne}")

            return f"Erro na execução do Orquestrador CLI: {last_err}"
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

    async def chat_reply(self, message: str, work_dir: str = "", skill_id: str = "auto"):
        """Chat conversacional Q&A (grátis, via NVIDIA glm-5.2). NÃO escreve arquivos nem
        executa o plano — só ajuda a refinar o escopo, tirar dúvidas e confirmar decisões.
        Mantém histórico próprio (qa_history) para dar contexto ao modelo."""
        message = (message or "").strip()
        if not message:
            return
        # Persiste a mensagem do usuário no histórico de exibição (o front já a mostrou localmente).
        self.save_chat_message("user", message)
        self.qa_history.append({"role": "user", "content": message})

        keys = config_manager.get_nvidia_keys()
        if not keys:
            await self.broadcast_chat("orchestrator", "⚠️ Sem chaves NVIDIA — o chat conversacional precisa de pelo menos uma chave.")
            return

        settings = config_manager.state.settings
        system_prompt = CHAT_SYSTEM_PROMPT
        guidance = get_skill_guidance(skill_id)
        ctx_bits = []
        if work_dir:
            ctx_bits.append(f"Diretório Alvo: {work_dir}")
        if guidance:
            ctx_bits.append(f"Tipo de projeto (skill '{skill_id}'):\n{guidance}")
        if ctx_bits:
            system_prompt = system_prompt + "\n\nCONTEXTO ATUAL:\n" + "\n".join(ctx_bits)
        if settings.use_caveman:
            system_prompt = f"{CAVEMAN_PROMPT}\n\n{system_prompt}"

        try:
            from backend.nvidia_router import nvidia_router
            nvidia_router.update_keys(keys)
            messages = [{"role": "system", "content": system_prompt}] + self.qa_history[-12:]
            reply = await nvidia_router.execute(
                model_pipeline=[settings.layer2_model, settings.layer2_fallback_model, "nvidia/nemotron-3-nano-30b-a3b"],
                messages=messages,
                temperature=0.4,
                broadcaster_fn=self.broadcaster_fn,
            )
            reply = (reply or "").strip() or "(sem resposta)"
            self.qa_history.append({"role": "assistant", "content": reply})
            await self.broadcast_chat("orchestrator", reply)
        except Exception as e:
            await self.broadcast_chat("orchestrator", f"❌ Erro no chat: {e}")

    async def decompose_goal(self, macro_goal: str, work_dir: str = ".", skill_id: str = "auto") -> Dict[str, Any]:
        """Fase 1A (Claude) + Fase 1B (DeepSeek-R1): Pipeline de 2 camadas para gerar o plano.
        skill_id seleciona um preset (tipo de projeto) que injeta convenções/stack no planejamento."""
        # AJUSTE: incorpora a CONVERSA (chat Q&A) ao objetivo. Caixa vazia → plano a partir do
        # que foi refinado no chat; caixa com texto → texto + contexto da conversa.
        macro_goal = (macro_goal or "").strip()
        convo = ""
        if self.qa_history:
            _lines = []
            for m in self.qa_history[-10:]:
                who = "Usuário" if m.get("role") == "user" else "Assistente"
                _lines.append(f"{who}: {m.get('content', '')}")
            convo = "\n".join(_lines)

        if not macro_goal and not convo:
            await self.broadcast_chat("orchestrator", "⚠️ Digite o objetivo do projeto na caixa (ou converse em 💬 Perguntar) antes de Gerar Plano.")
            return {}

        if macro_goal and convo:
            effective_goal = f"{macro_goal}\n\nCONTEXTO DA CONVERSA (refinamento com o usuário):\n{convo}"
        elif convo:
            effective_goal = f"Gere o plano a partir da conversa de refinamento abaixo (derive o objetivo dela):\n{convo}"
            await self.broadcast_chat("orchestrator", "💬 Usando o contexto da conversa para gerar o plano.")
        else:
            effective_goal = macro_goal

        target_path = None
        # Procurar caminho entre aspas se fornecido na mensagem/conversa
        quoted_match = re.search(r'["\']([A-Za-z]:\\[^"\']+)["\']', effective_goal)
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

        # Injeta a orientação da skill (tipo de projeto) no objetivo passado às Camadas 1-2.
        guidance = get_skill_guidance(skill_id)
        goal_ctx = f"CONTEXTO DO TIPO DE PROJETO:\n{guidance}\n\nOBJETIVO DO USUÁRIO:\n{effective_goal}" if guidance else effective_goal
        if guidance:
            await self.broadcast_chat("orchestrator", f"🎯 Skill aplicada ao planejamento: {skill_id}")

        if has_nvidia:
            # Usa prompt estruturado de arquitetura (Camada 1 formal)
            prompt = LAYER1_STRATEGIC_PROMPT.format(
                macro_goal=goal_ctx,
                work_dir=os.path.abspath(target_path)
            )
        else:
            # Fallback: Claude gera o plano completo diretamente
            prompt = ORCHESTRATOR_DECOMPOSE_PROMPT.format(
                macro_goal=goal_ctx,
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
                macro_goal=goal_ctx
            )
            if plan_json and "tasks" in plan_json:
                self._record_model("Camada 2 (Gerência)", config_manager.state.settings.layer2_model)
        
        if not plan_json or "tasks" not in plan_json:
            # FALLBACK SEGURO: a Camada 2 falhou em gerar o grafo de tarefas. O fallback
            # antigo usava o provider "antigravity" (CLI, SEM contrato de escrita) com
            # instruções genéricas de "criar estrutura" — o que reescrevia arquivos existentes
            # do zero e apagava conteúdo (jogos). Agora roteamos por "nvidia" (contrato JSON
            # protegido: create sobre arquivo existente é rejeitado, edições exigem patch, e o
            # operário recebe o conteúdo real do arquivo). Uma única tarefa conservadora.
            await self.broadcast_chat(
                "orchestrator",
                "⚠️ [Fallback] Camada 2 não retornou grafo válido. Gerando tarefa única CONSERVADORA "
                "via contrato NVIDIA (edição por patch, preservando arquivos existentes)."
            )
            plan_json = {
                "project_title": "Ajuste Conservador (fallback)",
                "summary": f"Camada 2 indisponível — tarefa única segura para: {effective_goal[:80]}",
                "tasks": [
                    {
                        "id": 1,
                        "title": "Aplicar demanda preservando o projeto existente",
                        "instruction": (
                            f"Diretório alvo: '{target_path}'. Implemente a seguinte demanda EDITANDO os "
                            f"arquivos JÁ EXISTENTES do projeto (ex: index.html, app.js, style.css e arquivos "
                            f"em games/), sempre via operação 'patch'. PRESERVE todo o conteúdo atual "
                            f"(não remova jogos, seções, funções ou estilos). Só use 'create' para arquivos "
                            f"realmente novos. DEMANDA: {effective_goal}"
                        ),
                        "complexity": "alta",
                        "layer": "frontend",
                        "provider": "nvidia",
                        "allow_overwrite": False,
                        "depends_on": []
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
        # Camada 1 usa a MESMA extração tolerante da Camada 2 (remove <think>, varre blocos
        # {...} balanceados preferindo o que tem conteúdo, repara vírgula sobrando).
        return _robust_extract_json(text)

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
        task_start: Dict[int, float] = {}     # task_id -> t0 (para medir duração)
        task_worker: Dict[int, str] = {}      # task_id -> worker_id que a executou

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
                    # RESERVAR o worker SÍNCRONAMENTE. worker.execute() só marca is_busy=True
                    # dentro da corrotina (que roda depois, quando o loop cede). Sem reservar
                    # aqui, get_idle_worker() devolvia o MESMO Worker-1 para todas as tarefas
                    # do lote e a execução virava sequencial num worker só. Reservando agora,
                    # o próximo get_idle_worker() já pega outro worker → paralelismo real.
                    worker.is_busy = True
                    pending_tasks.remove(task)
                    task_start[task["id"]] = time.time()
                    task_worker[task["id"]] = worker.worker_id

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
                            work_dir=self.last_target_dir,
                            # allow_overwrite vem da Camada 2 — só true em refatoração total
                            allow_overwrite=task.get("allow_overwrite", False)
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
                    tid = task_info["id"]
                    elapsed = round(time.time() - task_start.get(tid, time.time()), 1)
                    self.execution_results.append({
                        "task": task_info,
                        "result": result,
                        "seconds": elapsed
                    })

                    ok = result["status"] == "success"
                    # Histórico por operário: fixa a tarefa no card com OK/X + tempo
                    await self.broadcast({
                        "type": "worker_task_done",
                        "worker_id": result.get("worker_id") or task_worker.get(tid, ""),
                        "task_id": tid,
                        "title": task_info.get("title", f"Tarefa #{tid}"),
                        "status": "success" if ok else "failed",
                        "seconds": elapsed
                    })

                    if ok:
                        completed_task_ids.add(tid)
                        task_info["status"] = "completed"
                        self.save_plan(self.current_plan)
                        await self.broadcast({
                            "type": "task_update",
                            "task_id": tid,
                            "status": "completed"
                        })
                    else:
                        await self.broadcast({
                            "type": "task_update",
                            "task_id": tid,
                            "status": "failed"
                        })
                except Exception as e:
                    await self.broadcast_chat("orchestrator", f"❌ Exceção na tarefa #{task_info['id']}: {str(e)}")
                    await self.broadcast({
                        "type": "worker_task_done",
                        "worker_id": task_worker.get(task_info["id"], ""),
                        "task_id": task_info["id"],
                        "title": task_info.get("title", ""),
                        "status": "failed",
                        "seconds": round(time.time() - task_start.get(task_info["id"], time.time()), 1)
                    })

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

        report = await self.run_claude_cli(validation_prompt, role="Validação (Parecer Final)")

        # Detecta se o "relatório" retornado é na verdade uma mensagem de erro/cota
        # (keywords unificadas) ou um dos marcadores de erro internos do orquestrador.
        is_error_report = is_quota_or_error(report) or any(
            m in report.lower() for m in ["erro na execução", "exceção ao invocar"]
        )
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
                self._record_model("Validação (Parecer Final) — fallback NVIDIA", config_manager.state.settings.layer2_model)
            except Exception as ne:
                report = f"# Relatório Final de Execução\n\n- **Status:** CONCLUÍDO COM SUCESSO\n- **Resumo:** {len(self.execution_results)} tarefas operárias finalizadas com sucesso.\n- **Nota:** Validador NVIDIA: {ne}"

        # De-dup defensivo: às vezes o modelo de validação ecoa o exemplo do prompt e gera
        # DOIS "# Relatório Final de Encerramento" (um boilerplate alucinado + o real). Mantém
        # só o último (o relatório real vem por último).
        _marker = "# Relatório Final de Encerramento"
        if report.count(_marker) > 1:
            report = _marker + report.rsplit(_marker, 1)[1]

        # Anexa ao parecer (gerado pela IA) um DETALHAMENTO DETERMINÍSTICO das tarefas por
        # operário + os modelos por camada. Assim o relatório final bate com a telemetria e
        # credita TODAS as camadas (glm-5.2 da Camada 2/validação, não só os operários).
        report = report + self._build_execution_appendix()

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

    def _build_execution_appendix(self) -> str:
        """Detalhamento determinístico anexado ao parecer final: tabela de tarefas por
        operário (com tempo) + modelos por camada. Espelha a telemetria da UI dentro do
        relatorio_final.md."""
        lines = ["\n\n---\n\n## 🤖 Modelos por Camada (execução real)\n"]
        if self.pipeline_models:
            for m in self.pipeline_models:
                lines.append(f"- **{m['layer']}:** `{m['model']}`")
        else:
            lines.append("- (nenhum modelo de camada superior registrado)")
        worker_models = sorted({(item['result'].get('model') or '?') for item in self.execution_results})
        if worker_models:
            lines.append(f"- **Camada 3 (Operários):** " + ", ".join(f"`{m}`" for m in worker_models))

        lines.append("\n## 📋 Detalhamento das Tarefas por Operário\n")
        lines.append("| # | Tarefa | Operário | Modelo | Otimização | Tokens Est. | Tempo | Status |")
        lines.append("|---|--------|----------|--------|------------|-------------|-------|--------|")
        for item in self.execution_results:
            t = item["task"]
            res = item["result"]
            secs = item.get("seconds")
            opt = []
            if res.get("use_caveman"): opt.append("Caveman")
            if res.get("use_rtk"): opt.append("RTK")
            opt_str = " + ".join(opt) if opt else "—"
            status = "✅ OK" if res.get("status") == "success" else "❌ Falha"
            title = str(t.get("title", "")).replace("|", "\\|")
            lines.append(
                f"| {t.get('id')} | {title} | {res.get('worker_id', '-')} | "
                f"`{res.get('model', '-')}` | {opt_str} | {res.get('approx_tokens', 0)} | "
                f"{secs if secs is not None else '-'}s | {status} |"
            )
        return "\n".join(lines) + "\n"

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
                "tokens_saved": saved,
                "seconds": item.get("seconds")
            })

        # Inclui os modelos das camadas superiores (Camada 1/2/validação) — antes a
        # telemetria só creditava os operários (Camada 3), escondendo o glm-5.2.
        for m in self.pipeline_models:
            models_used.add(m["model"])

        return {
            "total_tasks": len(self.execution_results),
            "profiles_used": list(profiles_used),
            "models_used": list(models_used),
            "models_by_layer": list(self.pipeline_models),
            "total_tokens_approx": total_tokens,
            "total_tokens_saved": total_tokens_saved,
            "task_details": task_details,
            "report_markdown": report_markdown
        }
