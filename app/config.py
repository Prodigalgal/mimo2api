"""配置管理模块"""

import os
import json
import threading
from pathlib import Path
from typing import List, Optional
from dataclasses import dataclass, asdict


@dataclass
class MimoAccount:
    """Mimo账号配置"""
    service_token: str
    user_id: str
    xiaomichatbot_ph: str
    login_time: str = ""
    last_test: str = ""
    is_valid: bool = False
    # Google/Xiaomi email+password import & auto-renew fields
    email: str = ""
    password: str = ""
    pass_token: str = ""
    c_user_id: str = ""
    device_id: str = ""
    auto_renew: bool = True
    last_renew: str = ""
    renew_error: str = ""

    def to_dict(self):
        d = asdict(self)
        d["token_masked"] = self.service_token[:16] + "..." + self.service_token[-6:] if len(self.service_token) > 22 else "***"
        # never expose secrets in API responses
        if d.get("password"):
            d["password"] = "***" if self.password else ""
        if d.get("pass_token"):
            pt = self.pass_token
            d["pass_token_masked"] = (pt[:12] + "..." + pt[-6:]) if len(pt) > 20 else ("***" if pt else "")
            d["pass_token"] = d["pass_token_masked"]
        d["has_password"] = bool(self.password)
        d["has_pass_token"] = bool(self.pass_token)
        return d


@dataclass
class Config:
    """应用配置"""
    api_keys: str = "sk-default"
    admin_password: str = "admin"
    mimo_accounts: List[MimoAccount] = None
    models: List[str] = None  # 自定义模型列表，None 表示自动探测
    tools_passthrough: bool = False  # 全局工具透传模式

    def __post_init__(self):
        if self.mimo_accounts is None:
            self.mimo_accounts = []
        if self.models is None:
            self.models = []

    def to_dict(self):
        d = {
            "api_keys": self.api_keys,
            "admin_password": self.admin_password,
            "mimo_accounts": [acc.to_dict() for acc in self.mimo_accounts],
            "tools_passthrough": self.tools_passthrough,
        }
        if self.models:
            d["models"] = self.models
        return d

    def to_save_dict(self):
        """用于保存到文件的格式（不含 token_masked / 脱敏字段）"""
        skip = {
            "token_masked", "pass_token_masked", "has_password", "has_pass_token",
        }
        d = {
            "api_keys": self.api_keys,
            "admin_password": self.admin_password,
            "mimo_accounts": [
                {
                    k: getattr(acc, k)
                    for k in MimoAccount.__dataclass_fields__
                    if k not in skip
                }
                for acc in self.mimo_accounts
            ],
            "tools_passthrough": self.tools_passthrough,
        }
        if self.models:
            d["models"] = self.models
        return d


class ConfigManager:
    """配置管理器 - 线程安全"""

    def __init__(self, config_file: str = os.getenv("MIMO2API_CONFIG_FILE", "config.json")):
        self.config_file = Path(config_file)
        self.config = Config()
        self.lock = threading.RLock()
        self.account_idx = 0
        self.load()

    def load(self):
        """加载配置"""
        if not self.config_file.exists():
            self.save()
            return
        try:
            with open(self.config_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
                accounts = [
                    MimoAccount(**{k: v for k, v in acc.items() if k in MimoAccount.__dataclass_fields__})
                    for acc in data.get('mimo_accounts', [])
                ]
                self.config = Config(
                    api_keys=data.get('api_keys', 'sk-default'),
                    admin_password=data.get('admin_password', 'admin'),
                    mimo_accounts=accounts,
                    models=data.get('models', []),
                    tools_passthrough=data.get('tools_passthrough', False)
                )
        except Exception as e:
            print(f"加载配置失败: {e}")
            self.config = Config()
            self.save()

    def save(self):
        """保存配置"""
        with self.lock:
            try:
                with open(self.config_file, 'w', encoding='utf-8') as f:
                    json.dump(self.config.to_save_dict(), f, indent=2, ensure_ascii=False)
            except Exception as e:
                print(f"保存配置失败: {e}")

    def validate_api_key(self, key: str) -> bool:
        """验证API Key"""
        with self.lock:
            keys = [k.strip() for k in self.config.api_keys.split(',')]
            return key in keys

    def get_next_account(self) -> Optional[MimoAccount]:
        """获取下一个账号（轮询）"""
        with self.lock:
            if not self.config.mimo_accounts:
                return None
            account = self.config.mimo_accounts[self.account_idx % len(self.config.mimo_accounts)]
            self.account_idx += 1
            return account

    def update_config(self, new_config: dict):
        """更新配置"""
        with self.lock:
            accounts = [
                MimoAccount(**{k: v for k, v in acc.items() if k in MimoAccount.__dataclass_fields__})
                for acc in new_config.get('mimo_accounts', [])
            ]
            self.config = Config(
                api_keys=new_config.get('api_keys', 'sk-default'),
                admin_password=new_config.get('admin_password', 'admin'),
                mimo_accounts=accounts,
                models=new_config.get('models', []),
                tools_passthrough=new_config.get('tools_passthrough', False)
            )
            self.save()

    def get_config(self) -> dict:
        """获取配置"""
        with self.lock:
            return self.config.to_dict()


# 全局配置管理器实例
config_manager = ConfigManager()
