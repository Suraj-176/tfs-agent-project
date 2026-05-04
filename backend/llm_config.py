import os
from dotenv import load_dotenv
from crewai import LLM

load_dotenv()

class LLMConfigManager:
    """Manages multi-provider LLM configuration with session memory support"""
    
    PROVIDERS = {
        "azure": "Azure OpenAI",
        "openai": "OpenAI (GPT-4)",
        "claude": "Claude (Anthropic)",
        "gemini": "Google Gemini"
    }
    
    @staticmethod
    def load_from_env():
        """Load default LLM configuration from .env file"""
        provider = os.getenv("LLM_PROVIDER", "azure").lower()
        
        if provider == "azure":
            return {
                "provider": "azure",
                "deployment_name": os.getenv("AZURE_OPENAI_DEPLOYMENT_NAME", ""),
                "api_version": os.getenv("AZURE_OPENAI_API_VERSION", ""),
                "endpoint": os.getenv("AZURE_OPENAI_ENDPOINT", ""),
                "api_key": os.getenv("AZURE_OPENAI_API_KEY", "")
            }
        elif provider == "openai":
            return {
                "provider": "openai",
                "api_key": os.getenv("OPENAI_API_KEY", ""),
                "model": os.getenv("OPENAI_MODEL", "gpt-4")
            }
        elif provider == "claude":
            return {
                "provider": "claude",
                "api_key": os.getenv("ANTHROPIC_API_KEY", ""),
                "model": os.getenv("CLAUDE_MODEL", "claude-3-5-sonnet-20241022")
            }
        elif provider == "gemini":
            return {
                "provider": "gemini",
                "api_key": os.getenv("GOOGLE_API_KEY", ""),
                "model": os.getenv("GEMINI_MODEL", "gemini-pro")
            }
        
        return {"provider": "azure"}
    
    @staticmethod
    def validate_config(config: dict) -> tuple[bool, str]:
        """
        Validate LLM configuration based on provider
        """
        provider = config.get("provider", "").lower()
        if not provider or provider not in LLMConfigManager.PROVIDERS:
            return False, f"Invalid provider. Choose from: {', '.join(LLMConfigManager.PROVIDERS.keys())}"
        
        if provider == "azure":
            required = ["deployment_name", "api_version", "endpoint", "api_key"]
            missing = [f for f in required if not (config.get(f) or "").strip()]
            if missing:
                return False, f"Missing Azure fields: {', '.join(missing)}"
        else:
            if not (config.get("api_key") or "").strip():
                return False, f"Missing API key for {provider}"
        
        return True, "Configuration is valid"

def get_configured_llm(llm_config: dict = None):
    """
    Create and return configured LLM instance.
    Optimized for performance and compatibility.
    """
    if not llm_config:
        llm_config = LLMConfigManager.load_from_env()
    
    is_valid, msg = LLMConfigManager.validate_config(llm_config)
    if not is_valid:
        raise ValueError(f"Invalid LLM configuration: {msg}")
    
    provider = llm_config.get("provider", "azure").lower()
    
    if provider == "azure":
        deployment = llm_config.get('deployment_name') or llm_config.get('model') or 'gpt-4'
        endpoint = (llm_config.get('endpoint') or "").strip().rstrip('/')
        api_key = (llm_config.get('api_key') or "").strip()
        api_version = (llm_config.get('api_version') or "").strip()
        
        # Set environment variables only if changed to avoid process overhead
        envs = {
            "AZURE_OPENAI_ENDPOINT": endpoint,
            "AZURE_ENDPOINT": endpoint,
            "AZURE_OPENAI_API_BASE": endpoint,
            "AZURE_API_BASE": endpoint,
            "AZURE_OPENAI_API_KEY": api_key,
            "AZURE_API_KEY": api_key,
            "OPENAI_API_KEY": api_key,
            "AZURE_OPENAI_API_VERSION": api_version,
            "AZURE_API_VERSION": api_version
        }
        for k, v in envs.items():
            if os.environ.get(k) != v:
                os.environ[k] = v
            
        return LLM(
            model=f"azure/{deployment}",
            api_key=api_key,
            base_url=endpoint,
            api_version=api_version,
            temperature=0.0,
        )
    elif provider == "openai":
        model_name = llm_config.get('model', 'gpt-4')
        if not model_name.startswith('openai/') and not model_name.startswith('gpt-'):
             model_name = f"openai/{model_name}"
        return LLM(model=model_name, api_key=llm_config['api_key'], temperature=0.0)
    elif provider == "claude":
        model_name = llm_config.get('model', 'claude-3-5-sonnet-20241022')
        if not model_name.startswith('anthropic/'):
            model_name = f"anthropic/{model_name}"
        return LLM(model=model_name, api_key=llm_config['api_key'], temperature=0.0)
    elif provider == "gemini":
        model_name = llm_config.get('model', 'gemini-pro')
        if not model_name.startswith('gemini/'):
            model_name = f"gemini/{model_name}"
        return LLM(model=model_name, api_key=llm_config['api_key'], temperature=0.0)
    
    raise ValueError(f"Unknown provider: {provider}")

def get_llm_client(llm_config: dict = None):
    return get_configured_llm(llm_config)
