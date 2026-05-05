"""
Bug Creation Agent - Agent #4
Specializes in creating and managing bug work items in TFS
"""

import re
import json
import logging
from typing import List, Dict, Optional
from dataclasses import dataclass
from crewai import Agent, Task, Crew
from ..llm_config import get_configured_llm
from ..tfs_tool import (
    create_work_item,
    update_bug,
    extract_project_name,
    link_attachment_to_work_item,
    remove_all_attachments,
    upload_attachment,
    sanitize_params
)

logger = logging.getLogger(__name__)

@dataclass
class BugReport:
    """Report for a single work item creation (Bug or Feature)"""
    bug_title: str
    work_item_type: str = "Bug"
    severity: str = "2 - High"
    priority: str = "1"
    reproduction_steps: str = ""
    bug_id: Optional[int] = None
    status: str = "Pending"
    assigned_to: Optional[str] = None


def create_bug_creation_agent(llm_config: dict = None):
    """
    Agent #4: TFS Bug Creation Specialist
    """
    llm = get_configured_llm(llm_config) if llm_config else None
    return Agent(
        role="TFS Bug Creation Specialist",
        goal="Create and manage TFS work items with perfect documentation",
        backstory="Expert quality engineer with 10+ years experience in documenting defects.",
        llm=llm,
        verbose=True,
        allow_delegation=False
    )


def clean_field_text(text):
    """
    Strips metadata labels but preserves section content.
    Also removes leading/trailing asterisks and markers.
    """
    if text is None: return None
    val = str(text).strip()
    if not val: return ""
    
    # Remove leading/trailing asterisks, hyphens, etc
    val = val.strip('*').strip('-').strip('#').strip()
    
    # Metadata labels that should be removed if they start a line
    metadata = ['Severity', 'Priority', 'Work Item Type', 'Bug Title', 'Feature Title']
    lines = val.split('\n')
    cleaned = []
    
    label_regex = r'^\s*(?:[\*#\-_>\s]*)\s*(?:' + '|'.join([k.replace(' ', r'\s+') for k in metadata]) + r')\s*[:\-]*.*$'
    
    for line in lines:
        if not line.strip():
            cleaned.append("")
        elif not re.match(label_regex, line.strip(), re.IGNORECASE):
            # Remove leading asterisks/hyphens from content lines too
            cleaned_line = line.lstrip('*').lstrip('-').lstrip('#').strip()
            if cleaned_line:
                cleaned.append(cleaned_line)
            
    return '\n'.join(cleaned).strip()


def parse_llm_analysis_to_bug_fields(llm_analysis: str, work_item_type: str = "Bug") -> dict:
    """
    Robust multi-strategy parser for AI responses.
    1. Attempts JSON extraction first (most reliable).
    2. Falls back to enhanced Regex-based section extraction.
    """
    if not llm_analysis: return {}
    text = str(llm_analysis).strip()
    result = {'title': '', 'description': '', 'repro_steps': '', 'actual_behavior': '', 'expected_behavior': '', 'severity': '2 - High', 'priority': '1'}
    
    # --- STRATEGY 1: JSON Parsing ---
    try:
        # Pre-clean: Extract text from common markdown code blocks
        json_text = text
        if "```json" in text:
            json_text = text.split("```json")[1].split("```")[0].strip()
        elif "```" in text:
            # Check if it looks like JSON inside a generic code block
            parts = text.split("```")
            if len(parts) >= 2:
                inner = parts[1].strip()
                if inner.startswith("{") and inner.endswith("}"):
                    json_text = inner
        
        # Find potential JSON start/end if there's surrounding text
        start_idx = json_text.find("{")
        end_idx = json_text.rfind("}")
        
        if start_idx != -1 and end_idx != -1:
            potential_json = json_text[start_idx:end_idx+1]
            data = json.loads(potential_json)
            
            # Map JSON keys to internal field names
            mapping = {
                'title': ['title', 'bug_title', 'feature_title', 'user_story_title', 'summary', 'name'],
                'description': ['description', 'overview', 'problem', 'problem_statement'],
                'repro_steps': ['reproduction_steps', 'repro_steps', 'steps', 'requirements', 'how_to_reproduce'],
                'actual_behavior': ['actual_behavior', 'actual_result', 'current_behavior', 'acceptance_criteria', 'actual'],
                'expected_behavior': ['expected_behavior', 'expected_result', 'desired_behavior', 'business_value', 'expected', 'technical_notes'],
                'severity': ['severity', 'bug_severity'],
                'priority': ['priority', 'bug_priority']
            }
            
            found_fields = 0
            for target_key, aliases in mapping.items():
                for alias in aliases:
                    val = data.get(alias)
                    if val is not None:
                        result[target_key] = str(val).strip()
                        found_fields += 1
                        break
            
            if result.get('title') or result.get('description'):
                logger.info(f"✅ Successfully parsed {work_item_type} fields via JSON")
                # Clean all fields
                for k in result:
                    if isinstance(result[k], str): 
                        result[k] = clean_field_text(result[k])
                return result
    except Exception as e:
        logger.debug(f"ℹ️ JSON parse attempt failed, falling back to Regex: {str(e)}")

    # --- STRATEGY 2: Robust State Machine Regex Parser ---
    logger.debug(f"🔍 Using regex state machine for {work_item_type} parsing")
    
    current_section = None
    section_content = []
    
    def save_section():
        if current_section and section_content:
            content = '\n'.join(section_content).strip()
            if current_section in result:
                result[current_section] = (result[current_section] + "\n" + content).strip() if result[current_section] else content
        section_content.clear()

    for line in text.split('\n'):
        clean = line.strip()
        if not clean: 
            if current_section and section_content:
                section_content.append("") # Preserve internal newlines
            continue
        
        # Enhanced header detection: **Header:** or Header: or # Header
        header_match = re.match(r'^[\*\s#]*([a-zA-Z\s]+?)[\:\-]+\s*(.*?)$', clean, re.IGNORECASE)
        
        if header_match:
            potential_header = header_match.group(1).strip().lower()
            content_after = header_match.group(2).strip().strip('*').strip()
            
            # Field Mappings
            if any(h in potential_header for h in ['title', 'summary', 'name']):
                save_section()
                current_section = 'title'
                if content_after: section_content.append(content_after)
            elif any(h in potential_header for h in ['description', 'overview', 'problem']):
                save_section()
                current_section = 'description'
                if content_after: section_content.append(content_after)
            elif any(h in potential_header for h in ['steps', 'repro', 'reproduce', 'requirements']):
                save_section()
                current_section = 'repro_steps'
                if content_after: section_content.append(content_after)
            elif any(h in potential_header for h in ['actual', 'current', 'acceptance']):
                save_section()
                current_section = 'actual_behavior'
                if content_after: section_content.append(content_after)
            elif any(h in potential_header for h in ['expected', 'should', 'desired', 'business']):
                save_section()
                current_section = 'expected_behavior'
                if content_after: section_content.append(content_after)
            elif 'severity' in potential_header:
                save_section()
                current_section = None
                if content_after: result['severity'] = content_after
            elif 'priority' in potential_header:
                save_section()
                current_section = None
                if content_after: result['priority'] = content_after
            else:
                if current_section: section_content.append(line)
        else:
            if current_section: section_content.append(line)
            
    save_section()
    
    # Final cleanup
    for k in result:
        if isinstance(result[k], str): 
            result[k] = clean_field_text(result[k])
            
    return result


def execute_bug_creation(
    work_item_id: int = None,
    work_item_type: str = "Bug",
    bug_description: str = "",
    bug_title: str = "",
    reproduction_steps: str = "",
    actual_behavior: str = "",
    expected_behavior: str = "",
    severity: str = "2 - High",
    priority: str = "1",
    tags: str = "",
    llm_config: dict = None,
    tfs_config: dict = None,
    assigned_to: str = "",
    area_path: str = "",
    iteration_path: str = "",
    screenshots: list = None,
    is_update: bool = False,
    related_work_item_id: int = None,
):
    """
    Main entry point for creating/updating Bugs/Features/User Stories.
    """
    wi_type = "Bug"
    if work_item_type:
        type_lower = work_item_type.lower()
        if "feature" in type_lower:
            wi_type = "Feature"
        elif "story" in type_lower:
            wi_type = "User Story"

    if is_update and not work_item_id:
        return {"success": False, "message": "Work Item ID required for update"}
    
    # 1. AI Analysis (if form data is sparse or screenshots are provided for analysis)
    llm_fields = {}
    if llm_config and (not (bug_title and (bug_description or reproduction_steps)) or screenshots):
        try:
            from ..prompts_manager import PromptsManager
            if wi_type == "Feature":
                base_prompt = PromptsManager.get_feature_report_prompt()
            elif wi_type == "User Story":
                base_prompt = PromptsManager.get_user_story_report_prompt()
            else:
                base_prompt = PromptsManager.get_bug_report_prompt()

            # SPEED OPTIMIZATION: Use direct LLM call instead of Crew
            llm = get_configured_llm(llm_config)
            
            # --- VISION SUPPORT: Prepare content list with text and optional images ---
            text_content = f"{base_prompt}\n\nAnalyze and format this input:\n{bug_description or reproduction_steps or bug_title or 'Analyze provided screenshots.'}"
            message_content = [{"type": "text", "text": text_content}]
            
            if screenshots:
                logger.info(f"📸 Sending {len(screenshots)} screenshots to AI for vision analysis")
                for s in screenshots:
                    if s.get("data"):
                        # Ensure it's a properly formatted data URL for vision models
                        img_data = s.get("data")
                        if not img_data.startswith("data:"):
                            img_data = f"data:image/png;base64,{img_data}"
                        
                        message_content.append({
                            "type": "image_url",
                            "image_url": {"url": img_data}
                        })
            
            # Direct LLM call (passing structured content list for vision support)
            analysis = llm.call([{"role": "user", "content": message_content}])
            llm_fields = parse_llm_analysis_to_bug_fields(str(analysis), wi_type)
        except Exception as e:
            logger.error(f"⚠️ AI analysis failed during bug creation: {e}")
            pass

    # 2. Metadata Fallback
    if not severity or severity == "2 - High":
        if llm_fields.get('severity'): severity = llm_fields['severity']
    if not priority or priority == "1":
        if llm_fields.get('priority'):
            p_val = str(llm_fields['priority'])
            priority = p_val[0] if p_val and p_val[0].isdigit() else priority

    # 3. Field Resolution (Prioritize non-empty values)
    final_title = clean_field_text(bug_title) or clean_field_text(llm_fields.get('title'))
    
    clean_desc = clean_field_text(bug_description) or clean_field_text(llm_fields.get('description'))
    clean_repro = clean_field_text(reproduction_steps) or clean_field_text(llm_fields.get('repro_steps'))
    clean_actual = clean_field_text(actual_behavior) or clean_field_text(llm_fields.get('actual_behavior'))
    clean_expected = clean_field_text(expected_behavior) or clean_field_text(llm_fields.get('expected_behavior'))
    
    if not final_title:
        # Generate a title from content if missing
        src = clean_desc or clean_repro or "New Work Item"
        final_title = f"{wi_type}: {src[:50]}..."
        
    # 4. Assembly (MASTER DESCRIPTION COMBINATION)
    final_description = ""
    final_repro = ""

    if wi_type == "Bug":
        # Build master block with all sections and headers for maximum visibility in TFS
        master_parts = []
        if clean_desc:
            master_parts.append(f"**Description:**\n{clean_desc}")
        
        if clean_repro:
            master_parts.append(f"**Steps to Reproduce:**\n{clean_repro}")
        
        if clean_actual:
            master_parts.append(f"**Actual Result:**\n{clean_actual}")
            
        if clean_expected:
            master_parts.append(f"**Expected Result:**\n{clean_expected}")
            
        # Combine everything into final_description - with headers for clarity
        final_description = "\n\n".join(master_parts)
        # ReproSteps also gets the full content (Description + Steps + Actual + Expected)
        # so it's visible in the main TFS bug view
        final_repro = final_description
    else:
        # Feature assembly with all sections
        parts = []
        if clean_desc: parts.append(f"**Overview:**\n{clean_desc}")
        if clean_repro: parts.append(f"**Requirements:**\n{clean_repro}")
        if clean_actual: parts.append(f"**Acceptance Criteria:**\n{clean_actual}")
        if clean_expected: parts.append(f"**Business Value:**\n{clean_expected}")
        final_description = "\n\n".join(parts)

    # 5. Attachments Processing
    attachment_urls = []
    if tfs_config and screenshots:
        try:
            for i, s in enumerate(screenshots):
                if s.get("data"):
                    res = upload_attachment(
                        s.get("filename", f"img_{i}.png"), 
                        s.get("data"), 
                        tfs_config['base_url'], 
                        tfs_config.get('pat_token'), 
                        tfs_config.get('username'), 
                        tfs_config.get('password')
                    )
                    if res.get("url"):
                        attachment_urls.append({"filename": s.get("filename"), "url": res.get("url")})
        except Exception as att_err:
            logger.error(f"⚠️ Attachment upload failed: {str(att_err)}")

    if attachment_urls:
        md = "\n\n**Screenshots:**\n" + "\n".join([f'![{a["filename"]}]({a["url"]})' for a in attachment_urls])
        if wi_type == "Bug" and final_repro: 
            final_repro += md
        else: 
            final_description += md

    # 6. TFS Interaction (Keyword Arguments to prevent positional errors)
    if not tfs_config: return {"success": False, "message": "Missing TFS config"}
    
    try:
        proj = tfs_config.get('project_name') or extract_project_name(tfs_config['base_url']) or "TruDocs"
        
        tfs_params = {
            "title": final_title,
            "description": final_description if final_description else None,
            "reproduction_steps": final_repro if wi_type == "Bug" and final_repro else None,
            "severity": severity,
            "priority": priority,
            "assigned_to": assigned_to,
            "iteration_path": iteration_path,
            "area_path": area_path,
            "tags": tags,
            "base_url": tfs_config.get('base_url'),
            "pat": tfs_config.get('pat_token'),
            "username": tfs_config.get('username'),
            "password": tfs_config.get('password'),
            "domain": tfs_config.get('domain'),
            "project_name": proj,
            "related_work_item_id": related_work_item_id
        }

        # Log the sanitized final parameters
        logger.info(f"=== FINAL TFS PARAMETERS ===")
        logger.info(json.dumps(sanitize_params(tfs_params), indent=2))

        if is_update:
            tfs_params["bug_id"] = work_item_id
            resp = update_bug(**tfs_params)
        else:
            tfs_params["work_item_type"] = wi_type
            resp = create_work_item(**tfs_params)
        
        if resp.status_code in [200, 201]:
            new_id = resp.json().get('id')
            if attachment_urls:
                # COMMENTED OUT AS REQUESTED: Only show screenshots in description, not in Attachments tab
                # if is_update: remove_all_attachments(new_id, tfs_config['base_url'], tfs_config.get('pat_token'), tfs_config.get('username'), tfs_config.get('password'))
                # for a in attachment_urls: link_attachment_to_work_item(new_id, a["url"], "Added by Agent", tfs_config['base_url'], tfs_config.get('pat_token'), tfs_config.get('username'), tfs_config.get('password'))
                pass
            return {"success": True, "bug_id": new_id, "message": f"{wi_type} processed successfully"}
        return {"success": False, "message": f"TFS Error: {resp.text}"}
    except Exception as e:
        return {"success": False, "message": str(e)}


from concurrent.futures import ThreadPoolExecutor, as_completed

def process_multiple_bugs(bugs_data: List[Dict], llm_config: dict = None, tfs_config: dict = None) -> Dict:
    """
    Process multiple bugs in parallel for massive speedup.
    """
    count = 0
    max_workers = min(10, len(bugs_data)) if len(bugs_data) > 0 else 1
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(execute_bug_creation, **b, llm_config=llm_config, tfs_config=tfs_config) for b in bugs_data]
        for future in as_completed(futures):
            try:
                res = future.result()
                if res.get('success'):
                    count += 1
            except Exception as e:
                logger.error(f"Error in parallel bug creation: {e}")
                
    return {"success": True, "processed": count}
