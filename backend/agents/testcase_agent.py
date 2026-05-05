from crewai import Agent
from ..llm_config import get_configured_llm
from ..prompts_manager import PromptsManager
import json
import re

def create_testcase_agent(llm_config: dict = None):
    """
    Agent #2: Test Case Generation Agent
    Generates structured test cases from user stories.
    """
    llm = get_configured_llm(llm_config) if llm_config else None
    
    agent = Agent(
        role="Senior QA Test Designer",
        goal="Analyze requirements and generate a structured JSON list of comprehensive QA test cases",
        backstory="""Expert QA engineer who provides data in structured JSON format.
        You focus on functional, boundary, and edge case coverage.
        Output MUST be valid JSON for programmatic processing.""",
        llm=llm,
        verbose=True,
        allow_delegation=False
    )
    
    return agent


def json_to_markdown_grid(test_cases: list) -> str:
    """
    Converts a JSON list of test cases into the specific 3-column 
    Markdown grid format required by the UI and Excel export.
    """
    if not test_cases:
        return "| Title | Step Action | Expected Results |\n|---|---|---|"
    
    lines = ["| Title | Step Action | Expected Results |", "|---|---|---|"]
    
    for tc in test_cases:
        title = str(tc.get("title", "Untitled Test Case")).replace("|", " ")
        # Row 1: Title Only
        lines.append(f"| {title} | | |")
        
        # Subsequent Rows: Steps
        steps = tc.get("steps", [])
        if not steps:
            # Add at least one empty step if none provided
            lines.append(f"| | [No steps provided] | [N/A] |")
            continue
            
        for step in steps:
            action = str(step.get("action", "")).replace("|", " ").replace("\n", " ")
            expected = str(step.get("expected", "")).replace("|", " ").replace("\n", " ")
            lines.append(f"| | {action} | {expected} |")
            
    return "\n".join(lines)


def execute_testcase_generation(
    work_item_id: int = None,
    story_details: str = None,
    sop_text: str = "",
    llm_config: dict = None,
    tfs_config: dict = None,
    test_mode: str = "functional",
    functional_prompt: str = "",
    ui_prompt: str = "",
    ui_screenshot_name: str = "",
    ui_screenshot_data: str = "",
    ui_screenshot_names: list[str] = None,
    ui_screenshot_data_list: list[str] = None,
    coverage_analysis: bool = False,
):
    """
    Execute Agent #2 with JSON-to-Grid transformation.
    """
    from crewai import Task, Crew
    from .code_reviewer_agent import execute_code_review
    from ..tfs_tool import fetch_user_story
    import logging

    logger = logging.getLogger(__name__)
    
    try:
        agent = create_testcase_agent(llm_config)
        
        if story_details:
            story = story_details
        elif work_item_id:
            tfs_cfg = tfs_config or {}
            story = fetch_user_story(
                work_item_id,
                base_url=tfs_cfg.get("base_url"),
                username=tfs_cfg.get("username"),
                password=tfs_cfg.get("password"),
                pat=tfs_cfg.get("pat_token"),
            )
        else:
            raise ValueError("Either work_item_id or story_details must be provided")
        
        mode = (test_mode or "functional").strip().lower()
        if mode not in {"functional", "ui", "both"}: mode = "functional"

        # Build prompts
        sop_block = f"\nRelevant SOP Context:\n{sop_text}\n" if sop_text else ""
        scope_block = {"functional": "functional only", "ui": "UI only", "both": "functional and UI"}[mode]
        
        default_functional = PromptsManager.get_functional_prompt()
        default_ui = PromptsManager.get_ui_prompt()

        # SPEED OPTIMIZATION: Use direct LLM call instead of Crew
        # CrewAI adds overhead for task/agent lifecycle. Direct call is much faster for JSON generation.
        llm = get_configured_llm(llm_config)
        
        # --- VISION SUPPORT: Prepare content list with text and optional images ---
        text_prompt = f"""
Generate comprehensive QA test cases ({scope_block}) for the following:
{story}
{sop_block}

Requirements:
- Provide high-quality functional and boundary scenarios.
- Output MUST be a valid JSON array of objects.

JSON Schema:
[
  {{
    "title": "Test Case Title",
    "steps": [
      {{ "action": "Step 1 action", "expected": "Step 1 expected" }},
      {{ "action": "Step 2 action", "expected": "Step 2 expected" }}
    ]
  }}
]

Strict Rules:
- Return ONLY the JSON array.
- No markdown formatting like ```json.
- No conversational text.
"""
        message_content = [{"type": "text", "text": text_prompt}]
        
        # Add screenshots to the message if provided (Vision support)
        screenshots = ui_screenshot_data_list or []
        if ui_screenshot_data: screenshots.append(ui_screenshot_data)
        
        if screenshots:
            import logging
            logging.getLogger(__name__).info(f"📸 Sending {len(screenshots)} screenshots for UI test case analysis")
            for img_data in screenshots:
                if img_data:
                    # Ensure properly formatted data URL
                    if not str(img_data).startswith("data:"):
                        img_data = f"data:image/png;base64,{img_data}"
                    
                    message_content.append({
                        "type": "image_url",
                        "image_url": {"url": img_data}
                    })
        
        raw_result = str(llm.call([{"role": "user", "content": message_content}])).strip()

        # Clean JSON if Agent wrapped it in blocks
        if "```" in raw_result:
            raw_result = raw_result.split("```")[1]
            if raw_result.startswith("json"): raw_result = raw_result[4:]
            raw_result = raw_result.strip()

        try:
            tc_data = json.loads(raw_result)
            if not isinstance(tc_data, list): tc_data = [tc_data]
        except Exception as e:
            logger.error(f"JSON Parse failed, attempting fallback repair: {e}")
            # Fallback: Try to find anything between [ ]
            match = re.search(r'\[\s*\{.*\}\s*\]', raw_result, re.DOTALL)
            if match:
                tc_data = json.loads(match.group(0))
            else:
                raise ValueError("AI failed to produce valid JSON structure")

        # Convert structured data to the Grid Format the UI needs
        grid_markdown = json_to_markdown_grid(tc_data)

        # Optimization: Only run reviewer if grid format looks broken (simple heuristic check)
        # Previously we always ran it, which was slow.
        if "|" not in grid_markdown or "---" not in grid_markdown:
            logger.info("🛠️ Grid format looks broken, running self-healing...")
            review_result = execute_code_review(grid_markdown, llm_config)
            final_output = review_result.get("result", grid_markdown)
        else:
            logger.info("✅ Grid format validated locally, skipping AI review for speed")
            final_output = grid_markdown

        return {
            "status": "success",
            "result": final_output,
            "json_data": tc_data,
            "agent": "Test Case Designer (High-Speed)"
        }
    
    except Exception as e:
        import traceback
        logger.error(f"❌ Generation Error: {str(e)}")
        return {
            "status": "error",
            "error": str(e),
            "details": traceback.format_exc(),
            "agent": "Test Case Designer"
        }
