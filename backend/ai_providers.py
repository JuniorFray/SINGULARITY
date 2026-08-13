import shutil
import json
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from backend.config_manager import DATA_DIR

class AIProviderConfig(BaseModel):
    id: str
    name: str
    cli_binary: str
    command_template: str
    skip_permissions_flag: str = "--dangerously-skip-permissions"
    default_model: str
    supported_models: List[str]
    is_active: bool = True

class ProviderRegistry:
    def __init__(self):
        self.providers: Dict[str, AIProviderConfig] = {}
        self.providers_file = DATA_DIR / "providers.json"
        self.load_providers()

    def load_providers(self):
        # Primeiro, define os provedores padrões
        default_providers = {
            "antigravity": AIProviderConfig(
                id="antigravity",
                name="Antigravity CLI (agy)",
                cli_binary="agy",
                command_template='{binary} --model="{model}" {flags} -p "{instruction}"',
                skip_permissions_flag="--dangerously-skip-permissions",
                default_model="Claude Sonnet 4.6 (Thinking)",
                supported_models=[
                    "Claude Sonnet 4.6 (Thinking)",
                    "Gemini 3.1 Pro (High)",
                    "Gemini 3.5 Flash (High)",
                    "Gemini 3.6 Flash (High)",
                    "Claude Opus 4.6 (Thinking)"
                ],
                is_active=True
            ),
            "claude_code": AIProviderConfig(
                id="claude_code",
                name="Claude Code CLI (claude)",
                cli_binary="claude",
                command_template='{binary} -p "{instruction}" {flags}',
                skip_permissions_flag="--dangerously-skip-permissions",
                default_model="claude-3-7-sonnet",
                supported_models=[
                    "claude-3-7-sonnet",
                    "claude-3-5-sonnet",
                    "claude-3-5-haiku"
                ],
                is_active=True
            ),
            "nvidia": AIProviderConfig(
                id="nvidia",
                name="NVIDIA AI Foundation / NIM",
                cli_binary="nvidia",
                command_template='{binary} --model="{model}" {flags} -p "{instruction}"',
                skip_permissions_flag="",
                default_model="nvidia/llama-3.1-nemotron-70b-instruct",
                supported_models=[
                    "nvidia/llama-3.1-nemotron-70b-instruct",
                    "meta/llama-3.3-70b-instruct",
                    "deepseek-ai/deepseek-r1",
                    "nvidia/mistral-nemo-minitron-8b-base"
                ],
                is_active=True
            )
        }

        # Carrega os provedores salvos no arquivo, se existir
        if self.providers_file.exists():
            try:
                with open(self.providers_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    for k, v in data.items():
                        self.providers[k] = AIProviderConfig(**v)
            except Exception as e:
                print(f"[ProviderRegistry] Erro ao carregar provedores: {e}")
                self.providers = default_providers
        else:
            self.providers = default_providers
            self.save_providers()

    def save_providers(self):
        try:
            with open(self.providers_file, "w", encoding="utf-8") as f:
                data = {k: v.model_dump() for k, v in self.providers.items()}
                json.dump(data, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"[ProviderRegistry] Erro ao salvar provedores: {e}")

    def get_provider(self, provider_id: str) -> Optional[AIProviderConfig]:
        return self.providers.get(provider_id)

    def list_providers(self) -> List[AIProviderConfig]:
        return list(self.providers.values())

    def add_custom_provider(self, config: AIProviderConfig):
        self.providers[config.id] = config
        self.save_providers()

    def remove_provider(self, provider_id: str):
        if provider_id in self.providers and provider_id not in ["antigravity", "claude_code"]:
            del self.providers[provider_id]
            self.save_providers()

    def build_command(
        self,
        provider_id: str,
        instruction: str,
        model: Optional[str] = None,
        skip_permissions: bool = True,
        use_rtk: bool = False
    ) -> str:
        provider = self.get_provider(provider_id) or self.providers["antigravity"]
        selected_model = model or provider.default_model

        # Resolver o caminho absoluto do executável para evitar erros no rtk
        binary_path = shutil.which(provider.cli_binary) or provider.cli_binary
        if " " in binary_path:
            binary_path = f'"{binary_path}"'

        flags = ""
        if skip_permissions and provider.skip_permissions_flag:
            flags = provider.skip_permissions_flag

        cmd = provider.command_template.format(
            binary=binary_path,
            model=selected_model,
            flags=flags,
            instruction=instruction
        ).strip()

        # RTK (Rust Token Killer): proxy que economiza 60-90% de tokens em operações de dev.
        # Prefixa `rtk ` ao comando final quando o setting use_rtk está ligado.
        # Antes este setting era decorativo (só aparecia na telemetria) — agora tem efeito real.
        if use_rtk:
            cmd = f"rtk {cmd}"

        return cmd

    def test_provider(self, provider_id: str) -> Dict[str, Any]:
        """Testa conectividade e saúde de um provedor de IA via CLI ou API HTTP."""
        provider = self.get_provider(provider_id)
        if not provider:
            return {"status": "error", "message": "Provedor não encontrado"}

        # ─── Provedor NVIDIA NIM (API HTTP) ──────────────────────────────────
        if provider_id == "nvidia" or provider.cli_binary == "nvidia":
            from backend.config_manager import config_manager
            from backend.nvidia_router import nvidia_router
            keys = config_manager.get_nvidia_keys()
            if not keys:
                return {
                    "status": "no_keys",
                    "message": "Nenhuma chave NVIDIA (nvapi-...) cadastrada. Adicione em Provedores → Chaves NVIDIA.",
                    "model": provider.default_model
                }

            import time
            import asyncio
            start_time = time.time()
            try:
                nvidia_router.update_keys(keys)
                test_model = provider.default_model or "nemotron-3-super-120b-a12b"

                async def _ping():
                    # IDs com prefixo do fabricante (formato exato do catálogo NVIDIA)
                    return await nvidia_router.execute(
                        model_pipeline=[test_model, "z-ai/glm-5.2", "meta/llama-3.3-70b-instruct"],
                        messages=[{"role": "user", "content": "Respond 'OK'"}],
                        temperature=0.1,
                        max_tokens=20
                    )

                res_text = asyncio.run(_ping())
                elapsed = round(time.time() - start_time, 2)
                return {
                    "status": "online",
                    "message": f"Conexão NVIDIA NIM OK ({elapsed}s) [{len(keys)} chave(s)]",
                    "latency": elapsed,
                    "output": res_text[:150]
                }
            except Exception as e:
                elapsed = round(time.time() - start_time, 2)
                return {
                    "status": "error",
                    "message": f"Erro NVIDIA NIM: {str(e)}",
                    "latency": elapsed
                }

        # ─── Provedores CLI (Antigravity, Claude Code, etc.) ──────────────────
        binary_path = shutil.which(provider.cli_binary)
        if not binary_path:
            return {
                "status": "binary_missing",
                "message": f"Executável '{provider.cli_binary}' não encontrado no PATH do sistema.",
                "binary": provider.cli_binary,
                "model": provider.default_model
            }

        import subprocess
        import time
        start_time = time.time()
        test_cmd = self.build_command(provider_id, "Respond 'OK'", provider.default_model, True)

        try:
            res = subprocess.run(
                test_cmd,
                shell=True,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=25,
                encoding="utf-8",
                errors="replace"
            )
            elapsed = round(time.time() - start_time, 2)
            stdout_str = res.stdout if res.stdout is not None else ""
            stderr_str = res.stderr if res.stderr is not None else ""
            output = (stdout_str + "\n" + stderr_str).strip()

            if "not logged in" in output.lower() or "please run /login" in output.lower() or "login required" in output.lower():
                return {
                    "status": "not_logged_in",
                    "message": "Requer autenticação: execute 'claude login' no terminal.",
                    "latency": elapsed,
                    "output": output[:200]
                }
            elif "invalid model" in output.lower() or "not recognized" in output.lower():
                return {
                    "status": "invalid_model",
                    "message": f"Modelo inválido selecionado: {provider.default_model}",
                    "latency": elapsed,
                    "output": output[:200]
                }
            elif "quota" in output.lower() or "rate limit" in output.lower() or "429" in output:
                return {
                    "status": "quota_exceeded",
                    "message": "Limite de cota de API detectado.",
                    "latency": elapsed,
                    "output": output[:200]
                }
            elif res.returncode == 0:
                return {
                    "status": "online",
                    "message": f"Conexão OK ({elapsed}s)",
                    "latency": elapsed,
                    "output": output[:150]
                }
            else:
                return {
                    "status": "error",
                    "message": f"Erro de execução (Código {res.returncode})",
                    "latency": elapsed,
                    "output": output[:200]
                }
        except subprocess.TimeoutExpired:
            return {
                "status": "timeout",
                "message": "Tempo limite esgotado (Timeout > 25s)",
                "latency": 25.0
            }
        except Exception as e:
            import traceback
            tb = traceback.format_exc()
            return {
                "status": "error",
                "message": f"Exceção no teste: {str(e)} | Details: {tb}"
            }

    def auto_fix(self) -> Dict[str, Any]:
        """Verifica e REPORTA o estado dos provedores. NÃO sobrescreve a escolha de modelo
        do usuário nem rotaciona perfis automaticamente (isso é decisão do usuário — ver
        seção 4 da reestruturação v2). É uma rotina de diagnóstico read-only."""
        from backend.config_manager import config_manager
        fixes = []

        # Report 1: modelo padrão atual de cada provedor CLI (sem sobrescrever)
        ag = self.providers.get("antigravity")
        if ag:
            fixes.append(f"Antigravity CLI — modelo padrão configurado: '{ag.default_model}' ({len(ag.supported_models)} modelos).")

        # Report 2: perfil ativo atual (sem rotacionar)
        active = config_manager.get_current_profile()
        fixes.append(f"Perfil/conta ativa: '{active.name}' (rotação só ocorre em falha real de cota).")

        # Report 3: presença dos binários CLI no PATH
        for p_id, p in list(self.providers.items()):
            if p.cli_binary == "nvidia":
                continue  # nvidia é API HTTP, não tem binário CLI
            path = shutil.which(p.cli_binary)
            if path:
                fixes.append(f"Provedor '{p.name}' encontrado no PATH: {path}")
            else:
                fixes.append(f"⚠️ Provedor '{p.name}' — binário '{p.cli_binary}' NÃO encontrado no PATH.")

        # Report 4: modelos por camada configurados (fonte de verdade viva via aba Provedores)
        s = config_manager.state.settings
        fixes.append(
            "Modelos por camada: "
            f"L1fb={s.layer1_fallback_model}, L2={s.layer2_model}, L2fb={s.layer2_fallback_model}, "
            f"L3={s.layer3_model}, L3fb={s.layer3_fallback_model}. "
            "Use '🔄 Verificar catálogo' na aba Provedores para validar contra o catálogo NVIDIA ao vivo."
        )

        return {
            "status": "success",
            "fixes": fixes
        }

provider_registry = ProviderRegistry()
