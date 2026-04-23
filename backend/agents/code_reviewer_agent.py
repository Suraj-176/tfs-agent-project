from crewai import Agent
from ..llm_config import get_configured_llm
import re

def create_code_reviewer_agent(llm_config: dict = None):
    """
    Agent #3: Code Reviewer & Self-Healing Agent (Hidden/Internal)
    Reviews generated test cases and automatically fixes errors
    """
    llm = get_configured_llm(llm_config) if llm_config else None
    
    agent = Agent(
        role="Code Reviewer & Self-Healing Specialist",
        goal="Review and validate generated output, detect errors, and auto-fix issues",
        backstory="""Expert in quality assurance and code review with expertise in:
        - Markdown table validation and format enforcement
        - Test case structure and syntax verification
        - Logical consistency and clarity analysis
        - Autonomous error detection and intelligent correction
        
        You automatically identify and fix common errors:
        - Malformed markdown tables
        - Invalid test case titles
        - Incomplete or unclear step actions
        - Missing expected results
        - Duplicate test scenarios
        
        You fix errors intelligently without requiring human intervention.""",
        llm=llm,
        verbose=True,
        allow_delegation=False
    )
    
    return agent


def validate_markdown_table(content: str) -> dict:
    """
    Enhanced markdown table validation
    """
    if not content or not isinstance(content, str):
        return {"valid": False, "error": "Content is empty or not a string", "issues": ["Empty content"]}

    lines = [line.strip() for line in content.splitlines() if line.strip()]
    
    # Find table start
    table_start = None
    for i, line in enumerate(lines):
        if line.count("|") >= 2: # At least two pipes for a potential table
            table_start = i
            break
    
    if table_start is None:
        return {"valid": False, "error": "No markdown table found", "issues": ["No markdown table detected"]}
    
    issues = []
    
    # Check header and separator
    if table_start + 1 >= len(lines):
        issues.append("Table too short - missing separator row")
    else:
        header = lines[table_start]
        separator = lines[table_start + 1]
        
        # Check if separator is valid
        if not all(c in "-|: " for c in separator) or separator.count("|") < 2:
            issues.append("Invalid table separator")
        
        col_count = header.count("|") - 1
        sep_col_count = separator.count("|") - 1
        
        if col_count < 3:
            issues.append(f"Insufficient columns: found {col_count}, need 3")
            
        # Check specific grid-style patterns (Title, Step, Expected)
        # Note: We allow empty title cells for step rows
        content_rows = lines[table_start + 2:]
        if content_rows:
            has_step_data = False
            for row in content_rows:
                parts = [p.strip() for p in row.split("|") if p.strip() or row.count("|") > 2]
                # A valid row should have data in at least one column besides title
                if len(parts) >= 2:
                    has_step_data = True
                    break
            if not has_step_data:
                issues.append("Table has no step actions or expected results")

    return {
        "valid": len(issues) == 0,
        "issues": issues,
        "table_start": table_start
    }


def execute_code_review(content: str, llm_config: dict = None) -> dict:
    """
    Execute the Code Reviewer Agent with retry logic and self-healing
    """
    from crewai import Task, Crew
    import logging
    
    logger = logging.getLogger(__name__)
    max_retries = 1 # Reduced for performance/timeouts
    retry_count = 0
    current_content = content
    all_issues = []
    
    try:
        agent = create_code_reviewer_agent(llm_config)
        
        while retry_count <= max_retries:
            # Validate current content
            validation = validate_markdown_table(current_content)
            
            if validation["valid"]:
                return {
                    "status": "valid" if retry_count == 0 else "fixed",
                    "result": current_content,
                    "retry_count": retry_count,
                    "agent": "Code Reviewer"
                }
            
            all_issues.extend(validation.get("issues", []))
            
            # Attempt non-LLM auto-fix on first try
            if retry_count == 0:
                current_content = attempt_auto_fix(current_content)
                if validate_markdown_table(current_content)["valid"]:
                    continue 
            
            # Use LLM for complex fixes
            task = Task(
                description=f"""
Fix this markdown table. 
Rules:
1. Columns: | Title | Step Action | Expected Results |
2. First row of a test case: | Title | | |
3. Subsequent step rows: | | Step | Result |
4. Every row must start and end with |

Content:
{current_content}
""",
                agent=agent,
                expected_output="Corrected markdown table"
            )
            
            crew = Crew(agents=[agent], tasks=[task], verbose=True)
            result = crew.kickoff()
            current_content = str(result).strip()
            retry_count += 1
        
        return {
            "status": "partial_fix",
            "result": current_content,
            "issues": list(set(all_issues)),
            "agent": "Code Reviewer"
        }
        
    except Exception as e:
        import traceback
        logger.error(f"❌ Code Reviewer fatal error: {str(e)}")
        return {
            "status": "error",
            "error": str(e),
            "details": traceback.format_exc(),
            "agent": "Code Reviewer"
        }


def attempt_auto_fix(content: str) -> str:
    """
    Robust non-LLM auto-fix for markdown tables
    """
    if not content: return ""
    
    lines = content.split("\n")
    fixed_lines = []
    in_table = False
    col_count = 0
    
    for line in lines:
        stripped = line.strip()
        
        # Detect if we are in or starting a table
        if stripped.count("|") >= 2:
            if not in_table:
                in_table = True
                # Ensure it starts and ends with a pipe
                if not stripped.startswith("|"): stripped = "| " + stripped
                if not stripped.endswith("|"): stripped = stripped + " |"
                col_count = stripped.count("|") - 1
                fixed_lines.append(stripped)
            else:
                # Already in table, normalize pipes
                if not stripped.startswith("|"): stripped = "| " + stripped
                if not stripped.endswith("|"): stripped = stripped + " |"
                
                # Align column count
                current_cols = stripped.count("|") - 1
                if current_cols < col_count:
                    stripped = stripped.rstrip(" |") + (" |" * (col_count - current_cols)) + " |"
                elif current_cols > col_count:
                    # Too many pipes, try to merge last ones
                    parts = stripped.split("|")
                    stripped = "|".join(parts[:col_count+1]) + " |"
                
                fixed_lines.append(stripped)
        else:
            if in_table and not stripped:
                # End of table
                in_table = False
            fixed_lines.append(line)

    # Final pass: Ensure separator exists
    final_output = "\n".join(fixed_lines)
    if "| --- |" not in final_output:
        # We might need to inject a separator
        res = []
        table_started = False
        for line in fixed_lines:
            res.append(line)
            if line.strip().count("|") >= 2 and not table_started:
                table_started = True
                # Inject separator after the first header-like row
                cc = line.count("|") - 1
                sep = "|" + (" --- |" * cc)
                res.append(sep)
        return "\n".join(res)

    return final_output
