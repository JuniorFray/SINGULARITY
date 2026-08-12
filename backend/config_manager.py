import os
import json
from pathlib import Path
from pydantic import BaseModel
from typing import List, Dict, Any

DATA_DIR = Path("D:/Singularity - Sistema Orquestrador IA/data")
CONFIG_FILE = DATA_DIR / "orchestrator_config.json"
DEFAULT_PROFILES_DIR = Path.home() / ".antigravity_profiles"

class ProfileConfig(BaseModel):
    name: str
    path: str
    is_active: bool = True

class SettingsConfig(BaseModel):
    use_rtk: bool = True
    use_caveman: bool = True
    skip_permissions: bool = True
    auto_rotate_quota: bool = True
    max_workers: int = 2
    default_provider: str = "antigravity"
    default_model: str = "Claude Sonnet 4.6 (Thinking)"
    active_work_dir: str = "D:\\APP android teste"
    # Camada 2: Gerencial (NVIDIA NIM) — contexto longo + raciocínio
    layer2_model: str = "meta/llama-3.3-70b-instruct"
    layer2_fallback_model: str = "nvidia/nemotron-3-nano-30b-a3b"
    # Camada 3: Operacional (NVIDIA NIM) — coding + execução
    layer3_model: str = "meta/llama-3.1-8b-instruct"
    layer3_fallback_model: str = "nvidia/nemotron-3-nano-30b-a3b"
    # Auto-Healing
    auto_healing_model: str = "nvidia/nemotron-3-nano-30b-a3b"
    auto_healing_max_attempts: int = 3
    # NVIDIA Pool — chaves armazenadas separado por segurança
    nvidia_safe_rpm: int = 35

class AppState(BaseModel):
    settings: SettingsConfig = SettingsConfig()
    profiles: List[ProfileConfig] = []
    active_profile_index: int = 0

class ConfigManager:
    def __init__(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        DEFAULT_PROFILES_DIR.mkdir(parents=True, exist_ok=True)
        self.state = self.load_config()
        self._ensure_default_profiles()
        self.nvidia_keys_file = DATA_DIR / "nvidia_keys.json"

    def get_nvidia_keys(self) -> List[str]:
        if self.nvidia_keys_file.exists():
            try:
                with open(self.nvidia_keys_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return []

    def add_nvidia_key(self, key: str) -> List[str]:
        keys = self.get_nvidia_keys()
        if key not in keys:
            keys.append(key.strip())
            with open(self.nvidia_keys_file, "w", encoding="utf-8") as f:
                json.dump(keys, f)
        return keys

    def remove_nvidia_key(self, index: int) -> List[str]:
        keys = self.get_nvidia_keys()
        if 0 <= index < len(keys):
            keys.pop(index)
            with open(self.nvidia_keys_file, "w", encoding="utf-8") as f:
                json.dump(keys, f)
        return keys

    def _ensure_default_profiles(self):
        if not self.state.profiles:
            p1_path = str(DEFAULT_PROFILES_DIR / "perfil_primario")
            p2_path = str(DEFAULT_PROFILES_DIR / "perfil_secundario")
            
            Path(p1_path).mkdir(parents=True, exist_ok=True)
            Path(p2_path).mkdir(parents=True, exist_ok=True)

            self.state.profiles = [
                ProfileConfig(name="perfil_primario", path=p1_path, is_active=True),
                ProfileConfig(name="perfil_secundario", path=p2_path, is_active=True)
            ]
            self.save_config()

    def load_config(self) -> AppState:
        if CONFIG_FILE.exists():
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    return AppState(**data)
            except Exception as e:
                print(f"[ConfigManager] Erro ao carregar config: {e}. Usando padrões.")
        return AppState()

    def save_config(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(self.state.model_dump(), f, indent=2, ensure_ascii=False)

    def update_settings(self, new_settings: Dict[str, Any]):
        for key, val in new_settings.items():
            if hasattr(self.state.settings, key):
                setattr(self.state.settings, key, val)
        self.save_config()
        return self.state.settings

    def add_profile(self, name: str) -> ProfileConfig:
        clean_name = name.strip().lower().replace(" ", "_")
        p_path = str(DEFAULT_PROFILES_DIR / clean_name)
        Path(p_path).mkdir(parents=True, exist_ok=True)
        
        profile = ProfileConfig(name=clean_name, path=p_path, is_active=True)
        self.state.profiles.append(profile)
        self.save_config()
        return profile

    def remove_profile(self, name: str):
        self.state.profiles = [p for p in self.state.profiles if p.name != name]
        if self.state.active_profile_index >= len(self.state.profiles):
            self.state.active_profile_index = max(0, len(self.state.profiles) - 1)
        self.save_config()

    def get_current_profile(self) -> ProfileConfig:
        if not self.state.profiles:
            self._ensure_default_profiles()
        idx = self.state.active_profile_index % len(self.state.profiles)
        return self.state.profiles[idx]

    def rotate_profile(self) -> ProfileConfig:
        if not self.state.profiles:
            return self.get_current_profile()
        self.state.active_profile_index = (self.state.active_profile_index + 1) % len(self.state.profiles)
        self.save_config()
        return self.get_current_profile()

config_manager = ConfigManager()
