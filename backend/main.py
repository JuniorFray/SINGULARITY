import os
import sys
import json
import asyncio

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Dict, Any, Optional

from backend.config_manager import config_manager, DATA_DIR
from backend.ai_providers import provider_registry, AIProviderConfig
from backend.orchestrator import OrchestratorEngine

app = FastAPI(title="Singularity - Multi-Agent AI Orchestrator")

@app.on_event("startup")
async def startup_event():
    if sys.platform == "win32":
        try:
            asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
            print("[Startup] Windows Proactor Event Loop ativado com sucesso para subprocessos.")
        except Exception as e:
            print(f"[Startup] Aviso sobre Event Loop: {e}")

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: Dict[str, Any]):
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception as e:
                print(f"[WebSocket] Erro ao enviar mensagem: {e}")

ws_manager = ConnectionManager()
orchestrator = OrchestratorEngine(broadcaster_fn=ws_manager.broadcast)

# Models
class GoalRequest(BaseModel):
    macro_goal: str
    work_dir: Optional[str] = None
    skill_id: Optional[str] = "auto"

class ChatRequest(BaseModel):
    message: str
    work_dir: Optional[str] = None
    skill_id: Optional[str] = "auto"

class SettingsUpdateRequest(BaseModel):
    use_rtk: Optional[bool] = None
    use_caveman: Optional[bool] = None
    skip_permissions: Optional[bool] = None
    auto_rotate_quota: Optional[bool] = None
    use_cli_providers: Optional[bool] = None
    max_workers: Optional[int] = None
    default_provider: Optional[str] = None
    # Modelos por camada (dropdowns da aba Provedores, populados pelo catálogo ao vivo)
    layer1_fallback_model: Optional[str] = None
    layer2_model: Optional[str] = None
    layer2_fallback_model: Optional[str] = None
    layer3_model: Optional[str] = None
    layer3_fallback_model: Optional[str] = None

class ProfileCreateRequest(BaseModel):
    name: str

@app.get("/api/settings")
def get_settings():
    return config_manager.state

@app.post("/api/settings")
def update_settings(req: SettingsUpdateRequest):
    updated = config_manager.update_settings(req.model_dump(exclude_unset=True))
    orchestrator.worker_pool._update_worker_count()
    return updated

@app.get("/api/providers")
def get_providers():
    return provider_registry.list_providers()

@app.post("/api/providers")
def add_provider(provider: AIProviderConfig):
    provider_registry.add_custom_provider(provider)
    return {"status": "success", "provider": provider}

@app.delete("/api/providers/{provider_id}")
def remove_provider(provider_id: str):
    provider_registry.remove_provider(provider_id)
    return {"status": "success"}

# ─── NVIDIA Keys Management ──────────────────────────────────────────────────

class NvidiaKeyRequest(BaseModel):
    key: str

@app.get("/api/nvidia-keys")
def get_nvidia_keys():
    keys = config_manager.get_nvidia_keys()
    # Mascara as chaves para exibição segura
    masked = [f"nvapi-...{k[-6:]}" if len(k) > 10 else "***" for k in keys]
    return {"keys": masked, "count": len(keys)}

@app.post("/api/nvidia-keys")
async def add_nvidia_key(req: NvidiaKeyRequest):
    keys = config_manager.add_nvidia_key(req.key)
    # Atualizar o roteador em tempo real
    from backend.nvidia_router import nvidia_router
    nvidia_router.update_keys(keys)
    return {"status": "success", "count": len(keys)}

@app.delete("/api/nvidia-keys/{index}")
async def remove_nvidia_key(index: int):
    keys = config_manager.remove_nvidia_key(index)
    from backend.nvidia_router import nvidia_router
    nvidia_router.update_keys(keys)
    return {"status": "success", "count": len(keys)}

@app.get("/api/nvidia-keys/status")
async def nvidia_keys_status():
    """Status individual de cada chave do pool (válida/erro + RPM da janela).
    Reaproveita GET /v1/models como teste leve — não gasta chat completions."""
    keys = config_manager.get_nvidia_keys()
    if not keys:
        return {"status": "no_keys", "keys": []}
    from backend.nvidia_router import nvidia_router
    nvidia_router.update_keys(keys)
    try:
        per_key = await nvidia_router.validate_keys()
        return {"status": "ok", "keys": per_key}
    except Exception as e:
        return {"status": "error", "message": str(e), "keys": []}

@app.get("/api/nvidia-catalog/check")
async def check_nvidia_catalog():
    """Compara os modelos configurados por camada contra o catálogo NVIDIA VIVO
    (GET /v1/models). NUNCA troca modelo automaticamente — só reporta 'missing' para
    a UI mostrar um alerta e o usuário confirmar a mudança manualmente."""
    keys = config_manager.get_nvidia_keys()
    if not keys:
        return {"status": "no_keys", "message": "Nenhuma chave NVIDIA cadastrada."}
    from backend.nvidia_router import nvidia_router
    nvidia_router.update_keys(keys)
    try:
        catalog = await nvidia_router.list_catalog()
    except Exception as e:
        return {"status": "error", "message": str(e)}

    s = config_manager.state.settings
    configured = {
        "layer1_fallback_model": s.layer1_fallback_model,
        "layer2_model": s.layer2_model,
        "layer2_fallback_model": s.layer2_fallback_model,
        "layer3_model": s.layer3_model,
        "layer3_fallback_model": s.layer3_fallback_model,
    }
    catalog_set = set(catalog)
    missing = {k: v for k, v in configured.items() if v not in catalog_set}
    return {
        "status": "ok",
        "count": len(catalog),
        "catalog": sorted(catalog),
        "configured": configured,
        "missing": missing,
    }

@app.get("/api/profiles")
def get_profiles():
    return {
        "profiles": config_manager.state.profiles,
        "active_index": config_manager.state.active_profile_index
    }

@app.post("/api/profiles")
def add_profile(req: ProfileCreateRequest):
    p = config_manager.add_profile(req.name)
    return p

@app.delete("/api/profiles/{name}")
def remove_profile(name: str):
    config_manager.remove_profile(name)
    return {"status": "success"}

@app.get("/api/skills")
def get_skills():
    from backend.skills import list_skills
    return {"skills": list_skills()}

@app.post("/api/orchestrator/decompose")
async def decompose_project(req: GoalRequest):
    asyncio.create_task(orchestrator.decompose_goal(req.macro_goal, req.work_dir, req.skill_id or "auto"))
    return {"status": "started", "macro_goal": req.macro_goal}

@app.post("/api/orchestrator/chat")
async def orchestrator_chat(req: ChatRequest):
    asyncio.create_task(orchestrator.chat_reply(req.message, req.work_dir or "", req.skill_id or "auto"))
    return {"status": "started"}

@app.post("/api/orchestrator/execute")
async def execute_project(req: GoalRequest):
    asyncio.create_task(orchestrator.execute_plan(req.macro_goal))
    return {"status": "started"}

@app.post("/api/orchestrator/clear")
async def clear_orchestrator_state():
    """Zera chat + plano + resultados em memória E em disco. Faz o 'Limpar Tudo' da UI
    persistir após um refresh (antes só limpava o DOM e o init_state reenviava tudo)."""
    orchestrator.clear_state()
    await ws_manager.broadcast({"type": "state_cleared"})
    return {"status": "cleared"}

@app.get("/api/fs/browse")
def browse_fs(path: Optional[str] = None):
    """Navega pelo sistema de arquivos local para o seletor web de pastas."""
    import string
    drives = []
    if sys.platform == "win32":
        for letter in string.ascii_uppercase:
            drive_path = f"{letter}:\\"
            if os.path.exists(drive_path):
                drives.append(drive_path)
    else:
        drives = ["/"]

    current = path if (path and os.path.exists(path)) else config_manager.state.settings.active_work_dir
    if not current or not os.path.exists(current):
        current = drives[0] if drives else os.getcwd()

    current = os.path.abspath(current)
    parent = os.path.dirname(current) if os.path.dirname(current) != current else None

    folders = []
    try:
        with os.scandir(current) as it:
            for entry in it:
                try:
                    if entry.is_dir() and not entry.name.startswith(("$", ".")):
                        folders.append({
                            "name": entry.name,
                            "path": os.path.abspath(entry.path)
                        })
                except (PermissionError, OSError):
                    continue
        folders.sort(key=lambda x: x["name"].lower())
    except (PermissionError, OSError) as e:
        return {
            "status": "error",
            "message": f"Acesso negado: {str(e)}",
            "current_path": current,
            "parent_path": parent,
            "drives": drives,
            "folders": []
        }

    return {
        "status": "ok",
        "current_path": current,
        "parent_path": parent,
        "drives": drives,
        "folders": folders
    }

@app.post("/api/pick-folder")
async def pick_folder():
    """Abre um seletor nativo na máquina do usuário via Tkinter/PowerShell."""
    import subprocess
    
    ps_code = (
        "[void][System.Reflection.Assembly]::LoadWithPartialName('System.windows.forms');"
        "$f = New-Object System.Windows.Forms.FolderBrowserDialog;"
        "$f.Description = 'Selecione a pasta alvo do projeto';"
        "$f.ShowNewFolderButton = $true;"
        "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }"
    )

    def run_ps():
        try:
            out = subprocess.run(["powershell", "-NoProfile", "-Command", ps_code],
                                 capture_output=True, text=True, timeout=120)
            res = (out.stdout or "").strip()
            if res and os.path.exists(res):
                return res
        except Exception:
            pass
        return None

    tk_code = (
        "import tkinter as tk\n"
        "from tkinter import filedialog\n"
        "r = tk.Tk()\n"
        "r.withdraw()\n"
        "r.wm_attributes('-topmost', 1)\n"
        "p = filedialog.askdirectory(title='Selecione a pasta alvo do projeto')\n"
        "r.destroy()\n"
        "print(p or '')\n"
    )

    def run_tk():
        try:
            out = subprocess.run([sys.executable, "-c", tk_code],
                                 capture_output=True, text=True, timeout=120)
            return (out.stdout or "").strip()
        except Exception as e:
            return f"__ERROR__:{e}"

    path = await asyncio.to_thread(run_ps)
    if not path:
        path = await asyncio.to_thread(run_tk)

    if not path or path.startswith("__ERROR__:"):
        return {"status": "error", "message": "Nenhuma pasta selecionada.", "path": ""}
    return {"status": "ok", "path": path}

@app.post("/api/nvidia-models/health")
async def nvidia_models_health():
    """Probe de INFERÊNCIA REAL dos modelos configurados por camada (chat streaming de 1
    token). Faz o status 'ON' refletir se o modelo responde de fato — não apenas se a
    chave é válida / o modelo aparece no catálogo."""
    keys = config_manager.get_nvidia_keys()
    if not keys:
        return {"status": "no_keys", "models": []}
    from backend.nvidia_router import nvidia_router
    nvidia_router.update_keys(keys)
    s = config_manager.state.settings
    ordered = ["layer2_model", "layer2_fallback_model", "layer3_model",
               "layer3_fallback_model", "layer1_fallback_model"]
    models: List[str] = []
    for k in ordered:
        m = getattr(s, k, None)
        if m and m not in models:
            models.append(m)
    # Distribui chaves diferentes por probe para não estourar RPM de uma única chave.
    results = await asyncio.gather(*[
        nvidia_router.probe_model(m, key=keys[i % len(keys)]) for i, m in enumerate(models)
    ])
    return {"status": "ok", "models": results}

@app.post("/api/health-check")
async def run_health_check(provider_id: Optional[str] = None):
    if provider_id:
        res = await asyncio.to_thread(provider_registry.test_provider, provider_id)
        return {provider_id: res}
    
    providers = provider_registry.list_providers()
    tasks = [asyncio.to_thread(provider_registry.test_provider, p.id) for p in providers]
    results_list = await asyncio.gather(*tasks)
    
    results = {}
    for p, res in zip(providers, results_list):
        results[p.id] = res
    return results

@app.post("/api/auto-fix")
async def run_auto_fix():
    res = provider_registry.auto_fix()
    # Notificar ws sobre atualização de estado
    await ws_manager.broadcast({
        "type": "settings_updated",
        "settings": config_manager.state.settings.model_dump()
    })
    return res

@app.get("/api/orchestrator/telemetry")
def get_telemetry():
    telemetry_file = DATA_DIR / "latest_report.json"
    if telemetry_file.exists():
        with open(telemetry_file, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"status": "no_telemetry_yet"}

@app.get("/api/orchestrator/report-file")
def get_report_file():
    report_file = DATA_DIR / "relatorio_final.md"
    if report_file.exists():
        return FileResponse(report_file, media_type="text/markdown", filename="relatorio_final.md")
    raise HTTPException(status_code=404, detail="Relatório não encontrado")

# WebSocket Endpoint
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    await websocket.send_json({
        "type": "init_state",
        "state": config_manager.state.model_dump(),
        "providers": [p.model_dump() for p in provider_registry.list_providers()],
        "plan": orchestrator.current_plan,
        "chat_history": orchestrator.chat_history,
        "workers": [
            {
                "id": w.worker_id,
                "is_busy": w.is_busy,
                "task": w.current_task_title,
                "provider": w.current_provider,
                "profile": w.current_profile,
                "model": w.current_model
            } for w in orchestrator.worker_pool.workers
        ]
    })
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            
            if msg_type == "update_setting":
                config_manager.update_settings({data.get("key"): data.get("value")})
                await ws_manager.broadcast({
                    "type": "settings_updated",
                    "settings": config_manager.state.settings.model_dump()
                })
            elif msg_type == "user_prompt":
                macro_goal = data.get("prompt", "").strip()
                work_dir = data.get("work_dir", "D:\\Singularity - Sistema Orquestrador IA")
                skill_id = data.get("skill_id", "auto")
                if macro_goal:
                    asyncio.create_task(orchestrator.decompose_goal(macro_goal, work_dir, skill_id))
            elif msg_type == "chat_query":
                message = data.get("message", "").strip()
                work_dir = data.get("work_dir", "")
                skill_id = data.get("skill_id", "auto")
                if message:
                    asyncio.create_task(orchestrator.chat_reply(message, work_dir, skill_id))
            elif msg_type == "start_execution":
                macro_goal = data.get("prompt", "").strip()
                asyncio.create_task(orchestrator.execute_plan(macro_goal))

    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception as e:
        print(f"[WebSocket] Conexão encerrada: {e}")
        ws_manager.disconnect(websocket)

# Montar arquivos estáticos da UI Frontend
frontend_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
if os.path.exists(frontend_dir):
    app.mount("/static", StaticFiles(directory=frontend_dir), name="static")

@app.get("/")
def read_root():
    index_file = os.path.join(frontend_dir, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return {"message": "Singularity Server rodando em D:\\Singularity - Sistema Orquestrador IA"}
