import os
import json
import pandas as pd
from datetime import datetime
from dataclasses import dataclass
from typing import List, Dict, Optional
import re
import math
from crewai import Agent, Task, Crew
from ..llm_config import get_configured_llm
from ..tfs_tool import (
    fetch_user_story,
    create_task,
    update_task,
    find_existing_task,
    to_tfs_date,
    parse_date_flexible,
    resolve_tfs_identity,
    sanitize_params,
)


@dataclass
class TaskReport:
    """Report for a single task creation"""
    resource_email: str
    assigned_to_tfs: str
    task_title: str
    task_id: Optional[int] = None
    status: str = "Pending"  # Created, Failed, Skipped
    reason: Optional[str] = None
    iteration_path: Optional[str] = None
    hours: Optional[float] = None
    start_date: Optional[str] = None
    finish_date: Optional[str] = None


def create_tfs_task_agent(llm_config: dict = None):
    """
    Agent #1: TFS Task Creation Specialist
    Creates and manages task work items in TFS based on user stories
    """
    llm = get_configured_llm(llm_config) if llm_config else None
    
    agent = Agent(
        role="TFS Task Creation Specialist",
        goal="Create, decompose, and manage TFS task work items from user stories and requirements",
        backstory="""Expert in task decomposition and TFS work item management. 
        You understand how to break down complex user stories into actionable tasks, 
        identify dependencies, assign priorities, and ensure proper TFS task creation.
        You have deep knowledge of Agile methodologies and task estimation.""",
        llm=llm,
        verbose=True,
        allow_delegation=False
    )
    
    return agent


def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Normalize dataframe columns to lowercase"""
    df.columns = [str(c).strip().lower() for c in df.columns]
    return df

def _norm_col_key(name: str) -> str:
    return "".join(ch for ch in str(name).strip().lower() if ch.isalnum())

def _is_header_like_task_text(value: str) -> bool:
    text = str(value or "").strip().lower()
    return text in {"task", "tasks", "task description", "title", "activity", "activities"}


def get_col_value(row, possible_names):
    """Extract value from row using multiple possible column names"""
    for name in possible_names:
        key = str(name).strip().lower()
        if key in row.index:
            value = row[key]
            if pd.notna(value) and str(value).strip() != "":
                return str(value).strip()
    return None


def normalize_employee_name(value) -> str:
    """Normalize employee name to lowercase"""
    if pd.isna(value):
        return ""
    return str(value).strip().lower()


def resolve_employee_email(value, employee_map: dict = None) -> Optional[str]:
    """
    Resolve employee name or email to email address
    """
    if employee_map is None:
        employee_map = {}
    
    if pd.isna(value) or str(value).strip() == "":
        return None
    
    text = str(value).strip()
    
    # If already email, return as is
    if "@" in text and "." in text:
        return text.lower()
    
    # Look up in map
    normalized = normalize_employee_name(text)
    if normalized in employee_map:
        return employee_map[normalized]
    
    return None


def is_header_row(value) -> bool:
    """Check if row is employee header"""
    if pd.isna(value):
        return False
    text = str(value).strip().lower()
    return text == "date"


def parse_hours(value) -> Optional[float]:
    """Parse hours from value"""
    if value is None or str(value).strip() == "":
        return None
    try:
        text = str(value).strip().lower()
        num = float(text)
        if math.isnan(num) or math.isinf(num):
            return None
        return num
    except:
        pass

    try:
        text = str(value).strip().lower()
        m = re.search(r"(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\b", text)
        if m:
            num = float(m.group(1))
            if math.isnan(num) or math.isinf(num):
                return None
            return num
        m = re.search(r"^(\d{1,2}):(\d{2})$", text)
        if m:
            hh = int(m.group(1))
            mm = int(m.group(2))
            num = round(hh + (mm / 60.0), 2)
            if math.isnan(num) or math.isinf(num):
                return None
            return num
    except:
        pass

    return None


def parse_daily_tasks_excel(
    file_path: str,
    sheet_name: int = 0,
    employee_map: dict = None
) -> pd.DataFrame:
    """
    Parse daily tasks Excel file with flexible format detection
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Excel file not found: {file_path}")
    
    try:
        raw_df = pd.read_excel(file_path, sheet_name=sheet_name, header=None, engine='openpyxl')
    except Exception as excel_err:
        if "not a zip file" in str(excel_err).lower() or "openpyxl" in str(excel_err):
            try:
                raw_df = pd.read_csv(file_path, header=None)
            except Exception as csv_err:
                raise ValueError(f"Failed to parse file as Excel or CSV: {str(csv_err)}")
        else:
            raise
    
    if len(raw_df) == 0:
        raise ValueError("No task rows found in Excel file")
    
    records = []
    current_email = None
    
    first_row_vals = [str(raw_df.iloc[0, i]).strip() if i < len(raw_df.columns) else "" for i in range(min(5, len(raw_df.columns)))]
    is_header_format = any(val.lower() in ["date", "taskid", "task", "hours", "status"] for val in first_row_vals if val)
    
    if is_header_format:
        try:
            df_with_header = pd.read_excel(file_path, sheet_name=sheet_name, engine='openpyxl')
        except Exception:
            df_with_header = pd.read_csv(file_path)
        
        df_with_header.columns = df_with_header.columns.str.lower().str.strip()
        date_col = None
        task_id_col = None
        task_col = None
        hours_col = None
        status_col = None
        assigned_col = None
        
        for col in df_with_header.columns:
            col_lower = col.lower()
            if "taskid" in col_lower or "bugid" in col_lower:
                task_id_col = col
            elif "date" in col_lower:
                date_col = col
            elif "task" in col_lower or "description" in col_lower:
                task_col = col
            elif "hours" in col_lower or "time" in col_lower:
                hours_col = col
            elif "status" in col_lower:
                status_col = col
            elif "assign" in col_lower or "employee" in col_lower or "resource" in col_lower or "owner" in col_lower or (col_lower == "name"):
                assigned_col = col
        
        if not (date_col and task_col):
            raise ValueError(f"Could not find required Date and Task columns in header format.")
        
        if not assigned_col:
            current_email = "system"
        
        for idx, row in df_with_header.iterrows():
            try:
                date_val = row.get(date_col)
                task_id_val = row.get(task_id_col) if task_id_col else None
                task_val = row.get(task_col)
                hours_val = row.get(hours_col) if hours_col else None
                status_val = row.get(status_col) if status_col else None
                assigned_val = row.get(assigned_col) if assigned_col else current_email
                
                if pd.isna(date_val) and pd.isna(task_val): continue
                if pd.isna(date_val) or str(date_val).strip() == "": continue
                if not task_val or str(task_val).strip() == "": continue
                
                email = assigned_val if assigned_val else current_email
                if assigned_col:
                    mapped_email = resolve_employee_email(email, employee_map)
                    if mapped_email: email = mapped_email
                
                records.append({
                    "Assigned To": email or "system",
                    "Date": date_val,
                    "TaskID/BugID": str(task_id_val).strip() if task_id_val and not pd.isna(task_id_val) else None,
                    "Task": str(task_val).strip(),
                    "Hours": parse_hours(hours_val),
                    "Status": str(status_val).strip() if status_val and not pd.isna(status_val) else None,
                })
            except: continue
        
        if records:
            return normalize_columns(pd.DataFrame(records))
        else:
            raise ValueError("No task rows found in Excel file")
    
    # Dual-header format
    for i in range(len(raw_df)):
        row = raw_df.iloc[i]
        col0 = row[0] if len(row) > 0 else None
        mapped_email = resolve_employee_email(col0, employee_map)
        if mapped_email:
            current_email = mapped_email
            continue
        if is_header_row(col0): continue
        if all(pd.isna(x) or str(x).strip() == "" for x in row.tolist()): continue
        
        date_val = col0
        task_id = None if pd.isna(row[1]) or str(row[1]).strip() == "" else str(row[1]).strip()
        task_text = None if pd.isna(row[2]) else str(row[2]).strip()
        
        if not current_email or pd.isna(date_val) or str(date_val).strip() == "" or not task_text:
            continue
        
        records.append({
            "Assigned To": current_email,
            "Date": date_val,
            "TaskID/BugID": task_id,
            "Task": task_text,
            "Hours": parse_hours(row[3]),
            "Status": str(row[4]).strip() if len(row) > 4 and not pd.isna(row[4]) else None,
        })
    
    if records:
        return normalize_columns(pd.DataFrame(records))

    raise ValueError("No task rows found in Excel file")


def process_single_task(
    row: pd.Series,
    iteration_path: str,
    skip_duplicates: bool = True,
    base_url: str = None,
    pat: str = None,
    username: str = None,
    password: str = None,
    domain: str = "DGSL",
    default_assigned_to: str = None,
    logger=None,
    mode: str = "create"  # Added mode parameter
) -> Dict:
    """
    Process a single task row
    """
    if logger is None:
        logger = print
    
    # Extract title
    task_title = get_col_value(row, ["task", "task description", "title"])
    if not task_title:
        return {
            "status": "skipped",
            "reason": "Missing title",
            "report": TaskReport(resource_email="", assigned_to_tfs="", task_title="", status="Skipped", reason="Missing title"),
        }

    if _is_header_like_task_text(task_title):
        return {
            "status": "skipped",
            "reason": "Header row",
            "report": TaskReport(resource_email="", assigned_to_tfs="", task_title=task_title, status="Skipped", reason="Header row"),
        }
    
    if "leave" in task_title.lower():
        return {
            "status": "skipped",
            "reason": "Leave entry",
            "report": TaskReport(resource_email="", assigned_to_tfs="", task_title=task_title, status="Skipped", reason="Leave entry"),
        }
    
    # Check for existing task_id in CSV (for updates)
    task_id_raw = get_col_value(row, ["id", "task id", "taskid", "work item id", "workitemid", "wi id", "taskid/bugid"])
    task_id_to_update = None
    try:
        if task_id_raw and str(task_id_raw).strip() and str(task_id_raw).strip().lower() not in ["none", "null", "nan", ""]:
            task_id_to_update = int(float(str(task_id_raw).strip()))
            logger(f"   Task ID from CSV: {task_id_to_update}")
    except: pass

    # VALIDATION: If mode is "update" but no Task ID is provided
    if mode == "update" and not task_id_to_update:
        reason = "Skipped: 'Update' mode selected but no Task ID provided for this row."
        logger(f"⚠️  {reason}")
        return {
            "status": "skipped",
            "reason": reason,
            "report": TaskReport(resource_email="", assigned_to_tfs="", task_title=task_title, status="Skipped", reason=reason),
        }

    # Get assignee
    assigned_email = get_col_value(row, ["assigned to", "assignedto", "email", "email id", "resource", "resource name", "resource email", "employee", "employee name", "owner"])
    assigned_tfs = resolve_tfs_identity(assigned_email, domain, base_url, pat, username, password) if assigned_email else None
    
    if not assigned_tfs and default_assigned_to:
        assigned_tfs = default_assigned_to
    
    if not assigned_tfs:
        reason = "Missing assignee: Provide 'Assigned To' in CSV or 'username' in config"
        return {
            "status": "skipped",
            "reason": reason,
            "report": TaskReport(resource_email=assigned_email or "", assigned_to_tfs="", task_title=task_title, status="Skipped", reason=reason),
        }
    
    # Parse dates
    start_raw = get_col_value(row, ["date", "start date"]) or datetime.utcnow().strftime("%Y-%m-%d")
    start_date = to_tfs_date(start_raw, end_of_day=False)
    finish_date = to_tfs_date(start_raw, end_of_day=True)
    
    # Parse hours
    hours_raw = get_col_value(row, ["hours", "original estimate", "estimate", "duration", "time"])
    hours = parse_hours(hours_raw)
    
    # Check duplicates (only if creating)
    if mode == "create" and skip_duplicates and not task_id_to_update:
        try:
            existing_id = find_existing_task(task_title, assigned_tfs, start_date, base_url, pat, username=username, password=password, domain=domain)
            if existing_id:
                return {
                    "status": "skipped",
                    "reason": f"Duplicate (ID: {existing_id})",
                    "report": TaskReport(resource_email=assigned_email or "", assigned_to_tfs=assigned_tfs, task_title=task_title, task_id=existing_id, status="Skipped", reason="Duplicate task exists"),
                }
        except: pass
    
    # Create or Update task
    try:
        if task_id_to_update:
            response = update_task(task_id=task_id_to_update, title=task_title, assigned_to=assigned_tfs, start_date=start_date, finish_date=finish_date, original_estimate=hours, iteration_path=iteration_path, base_url=base_url, pat=pat, username=username, password=password, domain=domain)
            success_status = "Updated"
        else:
            response = create_task(title=task_title, assigned_to=assigned_tfs, start_date=start_date, finish_date=finish_date, original_estimate=hours, iteration_path=iteration_path, base_url=base_url, pat=pat, username=username, password=password, domain=domain)
            success_status = "Created"
        
        if response and response.status_code in [200, 201]:
            data = response.json()
            tid = data.get("id") or task_id_to_update
            return {
                "status": success_status.lower(),
                "task_id": tid,
                "report": TaskReport(resource_email=assigned_email or "", assigned_to_tfs=assigned_tfs, task_title=task_title, task_id=tid, status=success_status, hours=hours, start_date=start_date, finish_date=finish_date),
            }
        else:
            reason = response.text[:500] if response else "No response"
            return {
                "status": "failed",
                "reason": reason,
                "report": TaskReport(resource_email=assigned_email or "", assigned_to_tfs=assigned_tfs, task_title=task_title, status="Failed", reason=reason, hours=hours, start_date=start_date, finish_date=finish_date),
            }
    except Exception as e:
        return {
            "status": "failed",
            "reason": str(e),
            "report": TaskReport(resource_email=assigned_email or "", assigned_to_tfs=assigned_tfs, task_title=task_title, status="Failed", reason=str(e), hours=hours, start_date=start_date, finish_date=finish_date),
        }


def process_task_batch(
    excel_file: str,
    iteration_path: str,
    sheet_name=None,
    skip_duplicates: bool = True,
    tfs_config: dict = None,
    employee_map: dict = None,
    logger=None,
    mode: str = "create"
) -> Dict:
    """
    Process batch of tasks
    """
    if logger is None: logger = print
    tfs_config = tfs_config or {}
    username = (tfs_config.get("username") or "").strip()
    password = tfs_config.get("password") or ""
    pat_token = (tfs_config.get("pat_token") or "").strip()
    base_url = (tfs_config.get("base_url") or "").strip()
    domain = (tfs_config.get("domain") or "DGSL").strip() or "DGSL"
    
    default_assigned_to = resolve_tfs_identity(username, domain, base_url, pat_token, username, password) if username else None
    
    try:
        df = parse_daily_tasks_excel(excel_file, sheet_name=(sheet_name or 0), employee_map=employee_map)
        
        success_count = 0
        failed_count = 0
        skipped_count = 0
        created_ids = []
        report_rows = []
        errors = []
        
        for idx, row in df.iterrows():
            try:
                result = process_single_task(row, iteration_path=iteration_path, skip_duplicates=skip_duplicates, base_url=base_url, pat=pat_token, username=username, password=password, domain=domain, default_assigned_to=default_assigned_to, logger=logger, mode=mode)
                
                if result["status"] in ["created", "updated"]:
                    success_count += 1
                    created_ids.append(result["task_id"])
                elif result["status"] == "skipped":
                    skipped_count += 1
                else:
                    failed_count += 1
                    errors.append(result.get("reason", "Unknown error"))
                
                report_rows.append(result["report"])
            except Exception as e:
                failed_count += 1
                errors.append(str(e))
        
        return {
            "status": "success" if failed_count == 0 else "partial",
            "success_count": success_count,
            "failed_count": failed_count,
            "skipped_count": skipped_count,
            "total": len(df),
            "created_ids": created_ids,
            "report_rows": [vars(r) for r in report_rows],
            "errors": errors,
        }
    except Exception as e:
        return {"status": "error", "error": str(e), "report_rows": []}


def execute_task_creation(
    work_item_id: int = None,
    task_description: str = "",
    excel_file: str = None,
    iteration_path: str = None,
    llm_config: dict = None,
    tfs_config: dict = None,
    batch_mode: bool = False,
    sheet_name=None,
    skip_duplicates: bool = True,
    mode: str = "create"
):
    # Open log file for debugging
    import os as os_module
    log_path = os_module.path.join(os_module.path.dirname(__file__), '..', '..', 'logs', 'bulk_processing.log')
    os_module.makedirs(os_module.path.dirname(log_path), exist_ok=True)
    
    def log_to_file(msg):
        print(msg)
        try:
            with open(log_path, 'a', encoding='utf-8') as f:
                f.write(msg + '\n')
        except: pass
    
    try:
        if batch_mode and excel_file:
            import base64, tempfile
            file_bytes = base64.b64decode(excel_file)
            with tempfile.NamedTemporaryFile(delete=False, suffix='.xlsx') as tmp:
                tmp.write(file_bytes)
                tmp_path = tmp.name
            
            try:
                result = process_task_batch(excel_file=tmp_path, iteration_path=iteration_path, sheet_name=sheet_name, skip_duplicates=skip_duplicates, tfs_config=tfs_config, logger=print, mode=mode)
                
                return {
                    "status": result.get("status", "success"),
                    "summary": {
                        "created": result.get("success_count", 0) if mode == "create" else 0,
                        "updated": result.get("success_count", 0) if mode == "update" else 0,
                        "failed": result.get("failed_count", 0),
                        "skipped": result.get("skipped_count", 0),
                        "total": result.get("total", 0),
                    },
                    "created_ids": result.get("created_ids", []) if mode == "create" else [],
                    "updated_ids": result.get("created_ids", []) if mode == "update" else [],
                    "report_rows": result.get("report_rows", []),
                    "errors": result.get("errors", []),
                    "agent": "TFS Task Agent (Bulk)",
                }
            finally:
                try: os.unlink(tmp_path)
                except: pass
        
        elif work_item_id and work_item_id > 0:
            agent = create_tfs_task_agent(llm_config)
            task = Task(description=f"Update TFS task {work_item_id} with: {task_description}", agent=agent, expected_output="Updated task details")
            result = Crew(agents=[agent], tasks=[task]).kickoff()
            return {"status": "success", "result": str(result), "agent": "TFS Task Agent (Update)", "task_id": work_item_id}
        
        elif task_description:
            agent = create_tfs_task_agent(llm_config)
            task = Task(description=f"Create subtasks for: {task_description}", agent=agent, expected_output="Structured subtasks")
            result = Crew(agents=[agent], tasks=[task]).kickoff()
            return {"status": "success", "result": str(result), "agent": "TFS Task Agent (Create)"}
        
        return {"status": "error", "error": "Invalid input parameters"}

    except Exception as e:
        return {"status": "error", "error": str(e), "summary": {"total": 0}, "report_rows": []}


def generate_task_excel_report(report_rows: List[Dict]) -> bytes:
    """Generate Excel from results"""
    import io
    if not report_rows:
        df = pd.DataFrame(columns=["ID", "Title", "Assigned To", "Original Estimate", "Completed Work", "Remaining Work", "Start Date", "Created Date"])
    else:
        data = []
        for r in report_rows:
            sd = r.get("start_date") or ""
            if sd and "T" in sd:
                try: sd = datetime.fromisoformat(sd.split(".")[0]).strftime("%d-%m-%Y")
                except: pass
            
            orig = r.get("hours") or 0
            data.append({
                "ID": r.get("task_id") or "",
                "Title": r.get("task_title") or "",
                "Assigned To": r.get("assigned_to_tfs") or r.get("resource_email") or "",
                "Original Estimate": orig,
                "Completed Work": 0,
                "Remaining Work": orig,
                "Start Date": sd,
                "Created Date": datetime.now().strftime("%d-%m-%Y")
            })
        df = pd.DataFrame(data)
    
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        df.to_excel(writer, index=False, sheet_name='Tasks')
    return output.getvalue()
