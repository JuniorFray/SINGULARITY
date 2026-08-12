"""
backend/nvidia_router.py
Roteador assíncrono e resiliente para o hub NVIDIA AI Foundation (NIM).
Controla vazão com semáforo + janela deslizante e rotaciona chaves ao atingir 429.
"""

import asyncio
import time
from typing import List, Dict, Any, Optional

try:
    from openai import AsyncOpenAI, RateLimitError, APIError
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False

NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"

def _safe_print(msg: str):
    try:
        print(msg)
    except Exception:
        try:
            print(msg.encode("ascii", errors="ignore").decode("ascii"))
        except Exception:
            pass

class NvidiaRouter:
    def __init__(self, api_keys: Optional[List[str]] = None, safe_rpm: int = 35):
        self.api_keys = api_keys or []
        self.key_index = 0
        self.safe_rpm_limit = safe_rpm
        self.semaphore = asyncio.Semaphore(max(1, safe_rpm))
        self.request_timestamps: List[float] = []
        self._lock = asyncio.Lock()

    def update_keys(self, keys: List[str]):
        """Atualiza o pool de chaves em tempo real."""
        self.api_keys = keys
        if self.key_index >= len(keys):
            self.key_index = 0

    def _get_client(self) -> Any:
        if not OPENAI_AVAILABLE:
            raise RuntimeError("Biblioteca 'openai' não instalada. Execute: pip install openai")
        if not self.api_keys:
            raise RuntimeError("Nenhuma chave NVIDIA cadastrada. Adicione uma chave 'nvapi-...' nas configurações.")
        key = self.api_keys[self.key_index % len(self.api_keys)]
        return AsyncOpenAI(base_url=NVIDIA_BASE_URL, api_key=key, timeout=45.0)

    async def _throttle_if_needed(self):
        """Janela deslizante de 60s — pausa inteligente antes de atingir o limite."""
        async with self._lock:
            now = time.time()
            self.request_timestamps = [t for t in self.request_timestamps if now - t < 60]

            if len(self.request_timestamps) >= self.safe_rpm_limit:
                oldest = self.request_timestamps[0]
                wait_time = 60.0 - (now - oldest)
                if wait_time > 0:
                    _safe_print(f"⏳ [NVIDIA Router] Próximo ao limite ({len(self.request_timestamps)}/{self.safe_rpm_limit} RPM). Pausando {wait_time:.1f}s...")
                    await asyncio.sleep(wait_time)

            self.request_timestamps.append(time.time())

    def _rotate_key(self):
        """Rotaciona para a próxima chave do pool."""
        if len(self.api_keys) > 1:
            self.key_index = (self.key_index + 1) % len(self.api_keys)
            self.request_timestamps.clear()
            _safe_print(f"🔄 [NVIDIA Router] Chave rotacionada para índice {self.key_index}")

    async def execute(
        self,
        model_pipeline: List[str],
        messages: List[Dict[str, str]],
        temperature: float = 0.2,
        max_tokens: int = 16384,
        broadcaster_fn=None
    ) -> str:
        """
        Executa requisição com fallback por modelo e rotação de chaves.
        model_pipeline: lista de modelos a tentar em ordem (ex: ['deepseek-r1', 'llama-70b'])
        """
        if not OPENAI_AVAILABLE:
            raise RuntimeError("openai não instalado. Execute: pip install openai>=1.35.0")

        if not self.api_keys:
            raise RuntimeError("Nenhuma chave NVIDIA configurada. Acesse Configurações → Chaves NVIDIA.")

        model_index = 0
        failed_keys_in_loop = 0

        async with self.semaphore:
            await self._throttle_if_needed()

            while model_index < len(model_pipeline):
                model = model_pipeline[model_index]
                try:
                    client = self._get_client()
                    if broadcaster_fn:
                        await broadcaster_fn({
                            "type": "terminal_log",
                            "worker_id": "nvidia_router",
                            "text": f"🟢 [NVIDIA NIM] Chamando modelo: {model}",
                            "log_type": "info"
                        })

                    response = await client.chat.completions.create(
                        model=model,
                        messages=messages,
                        temperature=temperature,
                        max_tokens=max_tokens
                    )
                    return response.choices[0].message.content or ""

                except Exception as e:
                    err_str = str(e).lower()
                    # Verificar 429 ou limite de taxa
                    if "429" in err_str or "rate limit" in err_str or "quota" in err_str:
                        _safe_print(f"⚠️ [NVIDIA Router] 429 na chave {self.key_index} com modelo {model}. Rotacionando...")
                        self._rotate_key()
                        failed_keys_in_loop += 1

                        if failed_keys_in_loop >= len(self.api_keys):
                            _safe_print(f"🚨 [NVIDIA Router] Todas as chaves atingiram o limite para {model}. Tentando próximo modelo...")
                            model_index += 1
                            failed_keys_in_loop = 0
                            await asyncio.sleep(2)
                        continue
                    else:
                        _safe_print(f"❌ [NVIDIA Router] Erro com {model}: {e}. Tentando fallback...")
                        model_index += 1
                        continue

        raise RuntimeError(f"[NVIDIA Router] Todos os modelos e chaves falharam: {model_pipeline}")

    async def execute_layer2(self, system_prompt: str, user_content: str, broadcaster_fn=None) -> str:
        """Atalho para Camada 2 (Gerencial — DeepSeek-R1 com fallback Llama)."""
        from backend.config_manager import config_manager
        settings = config_manager.state.settings
        pipeline = [settings.layer2_model, settings.layer2_fallback_model]
        return await self.execute(
            model_pipeline=pipeline,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content}
            ],
            temperature=0.1,
            broadcaster_fn=broadcaster_fn
        )

    async def execute_layer3(self, system_prompt: str, user_content: str, broadcaster_fn=None) -> str:
        """Atalho para Camada 3 (Operacional — Qwen Coder com fallback Llama)."""
        from backend.config_manager import config_manager
        settings = config_manager.state.settings
        pipeline = [settings.layer3_model, settings.layer3_fallback_model]
        return await self.execute(
            model_pipeline=pipeline,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content}
            ],
            temperature=0.2,
            broadcaster_fn=broadcaster_fn
        )

    async def execute_auto_healing(self, error_context: str, broken_code: str, broadcaster_fn=None) -> str:
        """Auto-Healing: envia erro + código ao DeepSeek para gerar instrução corretiva."""
        from backend.config_manager import config_manager
        settings = config_manager.state.settings
        pipeline = [settings.auto_healing_model, settings.layer2_fallback_model]
        system_prompt = (
            "Você é um engenheiro de software especialista em debugging. "
            "Analise o erro reportado e o código com problema. "
            "Retorne APENAS a instrução corretiva exata e direta para o operário corrigir o código, "
            "sem introduções ou explicações desnecessárias."
        )
        user_content = f"ERRO CAPTURADO:\n{error_context}\n\nCÓDIGO PROBLEMÁTICO:\n{broken_code}"
        return await self.execute(
            model_pipeline=pipeline,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content}
            ],
            temperature=0.1,
            broadcaster_fn=broadcaster_fn
        )


# Instância global do roteador — chaves carregadas dinamicamente
def _create_router() -> NvidiaRouter:
    from backend.config_manager import config_manager
    settings = config_manager.state.settings
    keys = config_manager.get_nvidia_keys()
    return NvidiaRouter(api_keys=keys, safe_rpm=settings.nvidia_safe_rpm)

nvidia_router = _create_router()
