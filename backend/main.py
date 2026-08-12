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

class SettingsUpdateRequest(BaseModel):
    use_rtk: Optional[bool] = None
    use_caveman: Optional[bool] = None
    skip_permissions: Optional[bool] = None
    auto_rotate_quota: Optional[bool] = None
    max_workers: Optional[int] = None
    default_provider: Optional[str] = None

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

@app.post("/api/orchestrator/decompose")
async def decompose_project(req: GoalRequest):
    asyncio.create_task(orchestrator.decompose_goal(req.macro_goal, req.work_dir))
    return {"status": "started", "macro_goal": req.macro_goal}

@app.post("/api/orchestrator/execute")
async def execute_project(req: GoalRequest):
    asyncio.create_task(orchestrator.execute_plan(req.macro_goal))
    return {"status": "started"}

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
                if macro_goal:
                    asyncio.create_task(orchestrator.decompose_goal(macro_goal, work_dir))
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
