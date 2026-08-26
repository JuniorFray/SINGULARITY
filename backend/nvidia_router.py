"""
backend/nvidia_router.py
Roteador assíncrono e resiliente para o hub NVIDIA AI Foundation (NIM).
Controla vazão com semáforo + janela deslizante e rotaciona chaves ao atingir 429.
"""

import asyncio
import time
from typing import List, Dict, Any, Optional

from backend.error_detection import is_rate_limited

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
        # timeout 240s + streaming: modelos reasoning (ex: z-ai/glm-5.2) têm cold-start
        # de ~65s ATÉ O PRIMEIRO TOKEN. Em modo não-streaming a chamada inteira estourava
        # o timeout e a camada caía no fallback fraco. max_retries=0 evita o SDK repetir a
        # chamada 3x internamente (era o que inflava o tempo de falha para 500s+).
        return AsyncOpenAI(base_url=NVIDIA_BASE_URL, api_key=key, timeout=240.0, max_retries=0)

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

                    # STREAMING: consome token a token. Isso mantém a conexão viva durante
                    # o cold-start (glm-5.2 leva ~65s até o 1º token) e permite retorno mesmo
                    # em respostas longas de modelos reasoning. Acumula e devolve o texto completo.
                    stream = await asyncio.wait_for(
                        client.chat.completions.create(
                            model=model,
                            messages=messages,
                            temperature=temperature,
                            max_tokens=min(max_tokens, 4096),
                            stream=True
                        ),
                        timeout=45.0
                    )
                    parts: List[str] = []
                    first_token_seen = False
                    start_stream_time = time.time()
                    last_progress_time = start_stream_time
                    token_count = 0

                    async for chunk in stream:
                        if not chunk.choices:
                            continue
                        delta = chunk.choices[0].delta.content
                        if delta:
                            token_count += 1
                            if not first_token_seen and broadcaster_fn:
                                first_token_seen = True
                                await broadcaster_fn({
                                    "type": "terminal_log",
                                    "worker_id": "nvidia_router",
                                    "text": f"🟢 [NVIDIA NIM] {model} começou a responder...",
                                    "log_type": "info"
                                })
                            parts.append(delta)
                            now = time.time()
                            if broadcaster_fn and (now - last_progress_time >= 2.5 or token_count % 60 == 0):
                                last_progress_time = now
                                elapsed = round(now - start_stream_time, 1)
                                await broadcaster_fn({
                                    "type": "terminal_log",
                                    "worker_id": "nvidia_router",
                                    "text": f"⚡ [NVIDIA NIM] {model} processando ({token_count} chunks | {elapsed}s)...",
                                    "log_type": "info"
                                })

                    full = "".join(parts)
                    if full.strip():
                        elapsed = round(time.time() - start_stream_time, 1)
                        if broadcaster_fn:
                            await broadcaster_fn({
                                "type": "terminal_log",
                                "worker_id": "nvidia_router",
                                "text": f"✅ [NVIDIA NIM] {model}: resposta completa ({token_count} chunks em {elapsed}s).",
                                "log_type": "success"
                            })
                        return full
                    # Resposta vazia → trata como falha e tenta o próximo modelo
                    raise RuntimeError(f"modelo '{model}' retornou resposta vazia")

                except Exception as e:
                    err_str = str(e).lower()
                    # Verificar 429 ou limite de taxa
                    if "429" in err_str or "rate limit" in err_str or "quota" in err_str:
                        prev_idx = self.key_index
                        _safe_print(f"⚠️ [NVIDIA Router] 429 na chave {self.key_index} com modelo {model}. Rotacionando...")
                        self._rotate_key()
                        failed_keys_in_loop += 1
                        # Visível na UI (antes só ia pro console do servidor)
                        if broadcaster_fn:
                            await broadcaster_fn({
                                "type": "terminal_log",
                                "worker_id": "nvidia_router",
                                "text": f"🔄 [NVIDIA Pool] 429 na chave #{prev_idx} — rotacionando para a chave #{self.key_index} ({len(self.api_keys)} no pool).",
                                "log_type": "warning"
                            })

                        if failed_keys_in_loop >= len(self.api_keys):
                            _safe_print(f"🚨 [NVIDIA Router] Todas as chaves atingiram o limite para {model}. Tentando próximo modelo...")
                            if broadcaster_fn:
                                await broadcaster_fn({
                                    "type": "terminal_log",
                                    "worker_id": "nvidia_router",
                                    "text": f"🚨 [NVIDIA Pool] Todas as {len(self.api_keys)} chaves no limite para {model}. Passando para o próximo modelo.",
                                    "log_type": "error"
                                })
                            model_index += 1
                            failed_keys_in_loop = 0
                            await asyncio.sleep(2)
                        continue
                    else:
                        _safe_print(f"❌ [NVIDIA Router] Erro com {model}: {e}. Tentando fallback...")
                        model_index += 1
                        continue

        raise RuntimeError(f"[NVIDIA Router] Todos os modelos e chaves falharam: {model_pipeline}")

    async def list_catalog(self) -> List[str]:
        """Lista os IDs de modelos VIVOS do catálogo NVIDIA (endpoint OpenAI-compatible
        GET /v1/models). Fonte de verdade viva para a aba Provedores. Rotaciona a chave
        em caso de 429."""
        if not OPENAI_AVAILABLE:
            raise RuntimeError("openai não instalado. Execute: pip install openai>=1.35.0")
        if not self.api_keys:
            raise RuntimeError("Nenhuma chave NVIDIA configurada.")

        last_err: Optional[Exception] = None
        for _ in range(max(1, len(self.api_keys))):
            try:
                client = self._get_client()
                resp = await client.models.list()
                ids = [getattr(m, "id", None) for m in resp.data]
                return [m for m in ids if m]
            except Exception as e:
                last_err = e
                # 429 → tenta a próxima chave; outro erro → aborta
                if is_rate_limited(str(e)):
                    self._rotate_key()
                    continue
                raise
        raise RuntimeError(f"Falha ao listar catálogo NVIDIA: {last_err}")

    async def validate_keys(self) -> List[Dict[str, Any]]:
        """Testa cada chave do pool individualmente via GET /v1/models (chamada leve —
        não gasta uma chamada de chat completions só para validar). Retorna status por
        chave (válida/erro) + uso atual da janela deslizante de RPM."""
        results: List[Dict[str, Any]] = []
        now = time.time()
        rpm_used = len([t for t in self.request_timestamps if now - t < 60])
        for i, key in enumerate(self.api_keys):
            masked = f"nvapi-...{key[-6:]}" if len(key) > 10 else "***"
            entry: Dict[str, Any] = {
                "index": i,
                "masked": masked,
                "valid": False,
                "error": None,
                "rpm_used": rpm_used,
                "rpm_limit": self.safe_rpm_limit,
            }
            if not OPENAI_AVAILABLE:
                entry["error"] = "openai não instalado"
                results.append(entry)
                continue
            try:
                client = AsyncOpenAI(base_url=NVIDIA_BASE_URL, api_key=key, timeout=20.0)
                await client.models.list()
                entry["valid"] = True
            except Exception as e:
                entry["error"] = str(e)[:160]
            results.append(entry)
        return results

    async def probe_model(self, model: str, key: Optional[str] = None, timeout: float = 120.0) -> Dict[str, Any]:
        """Testa INFERÊNCIA REAL de um modelo: um chat mínimo em streaming, sucesso no
        1º token. Diferente de list_catalog()/validate_keys() (que só checam a chave e o
        catálogo via GET /v1/models e não provam que o modelo serve chat agora)."""
        if not OPENAI_AVAILABLE:
            return {"model": model, "alive": False, "latency": None, "error": "openai não instalado"}
        if not self.api_keys and not key:
            return {"model": model, "alive": False, "latency": None, "error": "sem chaves"}
        use_key = key or self.api_keys[self.key_index % len(self.api_keys)]
        client = AsyncOpenAI(base_url=NVIDIA_BASE_URL, api_key=use_key, timeout=timeout, max_retries=0)
        t0 = time.time()
        try:
            stream = await client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": "Reply with only: ok"}],
                temperature=0, max_tokens=64, stream=True
            )
            reachable = False   # recebeu QUALQUER chunk → o modelo está servindo inferência
            got_content = False  # emitiu texto em delta.content
            async for chunk in stream:
                reachable = True
                if chunk.choices:
                    delta = chunk.choices[0].delta
                    # modelos reasoning podem colocar a saída em reasoning_content
                    if getattr(delta, "content", None) or getattr(delta, "reasoning_content", None):
                        got_content = True
                        break
            try:
                await stream.close()
            except Exception:
                pass
            dt = round(time.time() - t0, 1)
            if reachable:
                # serve inferência; nota se só veio raciocínio (sem texto ainda)
                note = None if got_content else "responde (só raciocínio no teste curto)"
                return {"model": model, "alive": True, "latency": dt, "error": note}
            return {"model": model, "alive": False, "latency": dt, "error": "resposta vazia"}
        except Exception as e:
            return {"model": model, "alive": False, "latency": round(time.time() - t0, 1), "error": str(e)[:140]}

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
