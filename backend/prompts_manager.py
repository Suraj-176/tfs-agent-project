"""
Prompts Manager - Load test case generation prompts from prompts.txt file
"""
from pathlib import Path
from typing import Dict, Optional

class PromptsManager:
    """Manage dynamic loading of test case prompts from file"""
    
    _prompts_cache: Optional[Dict[str, str]] = None
    
    @staticmethod
    def _get_prompts_file() -> Path:
        """Get path to prompts.txt file"""
        root = Path(__file__).parent.parent
        return root / "prompts.txt"
    
    @staticmethod
    def load_prompts() -> Dict[str, str]:
        """Load prompts for all agents from prompts.txt file
        
        Loads prompts for:
        - AGENT 1: TFS Task Agent
        - AGENT 2: Test Case Agent (functional, UI, combined)
        - AGENT 4: Bug Creation Agent
        - SUPPORT: Story Analysis
        """
        """Load prompts from prompts.txt file"""
        if PromptsManager._prompts_cache is not None:
            return PromptsManager._prompts_cache
        
        prompts_file = PromptsManager._get_prompts_file()
        
        if not prompts_file.exists():
            return {
                "functional": "No functional prompt found",
                "ui": "No UI prompt found",
                "combined": "No combined prompt found",
                "bug_report": "No bug report prompt found",
                "feature_report": "No feature report prompt found"
            }
        
        content = prompts_file.read_text(encoding='utf-8')
        prompts = {
            "functional": "",
            "ui": "",
            "combined": "",
            "bug_report": "",
            "feature_report": "",
            "user_story_report": ""
        }
        
        # Parse file sections
        current_section = None
        current_content = []
        
        for line in content.split('\n'):
            if '[FUNCTIONAL_PROMPT]' in line:
                if current_content and current_section:
                    prompts[current_section] = '\n'.join(current_content).strip()
                current_section = "functional"
                current_content = []
            elif '[UI_PROMPT]' in line:
                if current_content and current_section:
                    prompts[current_section] = '\n'.join(current_content).strip()
                current_section = "ui"
                current_content = []
            elif '[COMBINED_PROMPT]' in line:
                if current_content and current_section:
                    prompts[current_section] = '\n'.join(current_content).strip()
                current_section = "combined"
                current_content = []
            elif '[BUG_REPORT_PROMPT]' in line:
                if current_content and current_section:
                    prompts[current_section] = '\n'.join(current_content).strip()
                current_section = "bug_report"
                current_content = []
            elif '[FEATURE_REPORT_PROMPT]' in line:
                if current_content and current_section:
                    prompts[current_section] = '\n'.join(current_content).strip()
                current_section = "feature_report"
                current_content = []
            elif '[USER_STORY_PROMPT]' in line:
                if current_content and current_section:
                    prompts[current_section] = '\n'.join(current_content).strip()
                current_section = "user_story_report"
                current_content = []
            elif '[STORY_ANALYSIS_PROMPT]' in line:
                if current_content and current_section:
                    prompts[current_section] = '\n'.join(current_content).strip()
                current_section = "story_analysis"
                current_content = []
            elif '[TRUDOCS_SOP]' in line:
                if current_content and current_section:
                    prompts[current_section] = '\n'.join(current_content).strip()
                current_section = "trudocs_sop"
                current_content = []
            elif line.startswith('==') or line.startswith('[END'):
                # Skip separator lines
                continue
            elif current_section and line.strip():
                current_content.append(line)
        
        # Save last section
        if current_content and current_section:
            prompts[current_section] = '\n'.join(current_content).strip()
        
        PromptsManager._prompts_cache = prompts
        return prompts

    # ==================== AGENT 1: TFS Task Agent ====================
    # No specific prompt method required - uses general task templates
    
    # ==================== AGENT 2: Test Case Agent ====================
    @staticmethod
    def get_functional_prompt() -> str:
        """[AGENT 2] Get functional test case generation prompt"""
        prompts = PromptsManager.load_prompts()
        return prompts.get("functional", "")
    
    @staticmethod
    def get_ui_prompt() -> str:
        """[AGENT 2] Get UI test case generation prompt"""
        prompts = PromptsManager.load_prompts()
        return prompts.get("ui", "")
    
    @staticmethod
    def get_combined_prompt() -> str:
        """[AGENT 2] Get functional + UI combined test prompt"""
        prompts = PromptsManager.load_prompts()
        return prompts.get("combined", "")
    
    # ==================== AGENT 4: Bug Creation Agent ====================
    @staticmethod
    def get_bug_report_prompt() -> str:
        """[AGENT 4] Get bug report generation prompt"""
        prompts = PromptsManager.load_prompts()
        return prompts.get("bug_report", "")
    
    @staticmethod
    def get_feature_report_prompt() -> str:
        """[AGENT 4] Get feature report generation prompt"""
        prompts = PromptsManager.load_prompts()
        return prompts.get("feature_report", "")
    
    # ==================== SUPPORT: Story Analysis ====================
    @staticmethod
    def get_story_analysis_prompt() -> str:
        """[SUPPORT] Get story analysis prompt"""
        prompts = PromptsManager.load_prompts()
        return prompts.get("story_analysis", "")
    
    @staticmethod
    def get_trudocs_sop() -> str:
        """Get the detailed TruDocs SOP content"""
        prompts = PromptsManager.load_prompts()
        return prompts.get("trudocs_sop", "")
    
    @staticmethod
    def reload_prompts() -> None:
        """Clear cache to reload prompts from file"""
        PromptsManager._prompts_cache = None
