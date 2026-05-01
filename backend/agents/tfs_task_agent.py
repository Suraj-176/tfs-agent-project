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
    status: str = "Pending"  # Created, Updated, Failed, Skipped
    reason: Optional[str] = None
    iteration_path: Optional[str] = None
    hours: Optional[float] = None
    start_date: Optional[str] = None
    finish_date: Optional[str] = None


def create_tfs_task_agent(llm_config: dict = None):
    """
    Agent #1: TFS Task Creation Specialist
    """
    llm = get_configured_llm(llm_config) if llm_config else None
    return Agent(
        role="TFS Task Creation Specialist",
        goal="Create, decompose, and manage TFS task work items from user stories and requirements",
        backstory="Expert in task decomposition and TFS work item management.",
        llm=llm,
        verbose=True,
        allow_delegation=False
    )


def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Normalize dataframe columns to lowercase"""
    df.columns = [str(c).strip().lower() for c in df.columns]
    return df


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


def resolve_employee_email(value, employee_map: dict = None) -> Optional[str]:
    """Resolve employee name or email to email address"""
    if employee_map is None: employee_map = {}
    if pd.isna(value) or str(value).strip() == "": return None
    text = str(value).strip()
    if "@" in text and "." in text: return text.lower()
    normalized = text.lower()
    return employee_map.get(normalized)


def parse_hours(value) -> Optional[float]:
    """Parse hours from value"""
    if value is None or str(value).strip() == "": return None
    try:
        text = str(value).strip().lower()
        return float(text)
    except: pass
    return None


def parse_daily_tasks_excel(
    file_path: str,
    sheet_name: int = 0,
    employee_map: dict = None
) -> pd.DataFrame:
    """
    Parse daily tasks Excel file with flexible format detection
    """
    if not os.path.exists(file_path): raise FileNotFoundError(f"Excel file not found: {file_path}")
    
    try:
        raw_df = pd.read_excel(file_path, sheet_name=sheet_name, header=None, engine='openpyxl')
    except:
        raw_df = pd.read_csv(file_path, header=None)
    
    if len(raw_df) == 0: raise ValueError("No task rows found in Excel file")
    
    records = []
    
    # Header check
    first_row_vals = [str(raw_df.iloc[0, i]).strip().lower() for i in range(min(10, len(raw_df.columns)))]
    is_header_format = any(val in ["date", "taskid", "task", "hours", "status", "id", "title"] for val in first_row_vals if val)
    
    if is_header_format:
        try:
            df = pd.read_excel(file_path, sheet_name=sheet_name, engine='openpyxl')
        except:
            try: df = pd.read_csv(file_path, encoding='utf-8-sig')
            except: df = pd.read_csv(file_path)
        
        df.columns = df.columns.str.lower().str.strip()
        
        # Column finding
        date_col = next((c for c in df.columns if "date" in c), None)
        id_col = next((c for c in df.columns if c in ["id", "taskid", "bugid"] or "task id" in c), None)
        task_col = next((c for c in df.columns if c in ["task", "title"] or "description" in c), None)
        hours_col = next((c for c in df.columns if c in ["hours", "time", "estimate"] or "work" in c), None)
        assigned_col = next((c for c in df.columns if any(x in c for x in ["assigned", "employee", "resource", "owner", "name"])), None)
        
        if not (date_col and task_col): raise ValueError("Could not find required Date and Task columns.")
        
        for idx, row in df.iterrows():
            if pd.isna(row.get(date_col)) or pd.isna(row.get(task_col)): continue
            records.append({
                "Assigned To": str(row.get(assigned_col)).strip() if assigned_col and pd.notna(row.get(assigned_col)) else "system",
                "Date": row.get(date_col),
                "TaskID/BugID": str(row.get(id_col)).strip() if id_col and pd.notna(row.get(id_col)) else None,
                "Task": str(row.get(task_col)).strip(),
                "Hours": parse_hours(row.get(hours_col)),
            })
    else:
        # Heuristic/Dual header logic (Simplified for space)
        current_email = "system"
        for i in range(len(raw_df)):
            row = raw_df.iloc[i]
            val0 = str(row[0]).strip() if pd.notna(row[0]) else ""
            if not val0: continue
            if "date" in val0.lower(): continue
            # If row 0 is name, use it
            if "@" in val0 or len(val0.split()) > 1: current_email = val0
            # Else try row as task
            if len(row) > 2 and pd.notna(row[2]):
                records.append({
                    "Assigned To": current_email,
                    "Date": row[0],
                    "TaskID/BugID": str(row[1]).strip() if pd.notna(row[1]) else None,
                    "Task": str(row[2]).strip(),
                    "Hours": parse_hours(row[3]) if len(row) > 3 else None,
                })
    
    if not records: raise ValueError("No task rows found in Excel file")
    return normalize_columns(pd.DataFrame(records))


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
    mode: str = "create"
) -> Dict:
    if logger is None: logger = print
    
    task_title = get_col_value(row, ["task", "title", "description"])
    if not task_title:
        return {"status": "skipped", "reason": "Missing title", "report": TaskReport("", "", "", status="Skipped", reason="Missing title")}

    # ID Parsing
    task_id_raw = get_col_value(row, ["id", "taskid", "bugid", "taskid/bugid"])
    task_id_to_update = None
    try:
        if task_id_raw and str(task_id_raw).strip() and str(task_id_raw).strip().lower() not in ["none", "nan", ""]:
            task_id_to_update = int(float(str(task_id_raw).strip()))
    except: pass

    # STRICT VALIDATION FOR UPDATE MODE
    if mode == "update" and not task_id_to_update:
        reason = "Skipped: 'Update' mode selected but no Task ID provided for this row."
        logger(f"⚠️ {reason}")
        return {
            "status": "skipped",
            "reason": reason,
            "report": TaskReport("", "", task_title, status="Skipped", reason=reason, iteration_path=iteration_path)
        }

    # Get assignee
    assigned_email = get_col_value(row, ["assigned to", "employee", "resource", "name", "owner"])
    assigned_tfs = resolve_tfs_identity(assigned_email, domain, base_url, pat, username, password) if assigned_email else default_assigned_to
    
    # Dates & Hours
    start_raw = get_col_value(row, ["date"]) or datetime.utcnow().strftime("%Y-%m-%d")
    start_date = to_tfs_date(start_raw)
    finish_date = to_tfs_date(start_raw, end_of_day=True)
    hours = parse_hours(get_col_value(row, ["hours", "time", "estimate"]))

    try:
        if task_id_to_update:
            response = update_task(task_id=task_id_to_update, title=task_title, assigned_to=assigned_tfs, start_date=start_date, finish_date=finish_date, original_estimate=hours, iteration_path=iteration_path, base_url=base_url, pat=pat, username=username, password=password, domain=domain)
            status = "updated"
        else:
            response = create_task(title=task_title, assigned_to=assigned_tfs, start_date=start_date, finish_date=finish_date, original_estimate=hours, iteration_path=iteration_path, base_url=base_url, pat=pat, username=username, password=password, domain=domain)
            status = "created"
        
        if response and response.status_code in [200, 201]:
            tid = response.json().get("id") or task_id_to_update
            return {
                "status": status,
                "task_id": tid,
                "report": TaskReport(assigned_email or "", assigned_tfs or "", task_title, task_id=tid, status=status.capitalize(), hours=hours, start_date=start_date, finish_date=finish_date, iteration_path=iteration_path),
            }
        else:
            reason = response.text[:500] if response else "API error"
            return {
                "status": "failed",
                "reason": reason,
                "report": TaskReport(assigned_email or "", assigned_tfs or "", task_title, status="Failed", reason=reason, iteration_path=iteration_path),
            }
    except Exception as e:
        return {"status": "failed", "reason": str(e), "report": TaskReport("", "", task_title, status="Failed", reason=str(e))}


def process_task_batch(excel_file: str, iteration_path: str, tfs_config: dict = None, mode: str = "create", **kwargs) -> Dict:
    tfs_config = tfs_config or {}
    df = parse_daily_tasks_excel(excel_file, sheet_name=kwargs.get("sheet_name", 0))
    
    success_count = 0
    failed_count = 0
    skipped_count = 0
    created_ids = []
    report_rows = []
    errors = []
    
    for _, row in df.iterrows():
        res = process_single_task(row, iteration_path, base_url=tfs_config.get("base_url"), pat=tfs_config.get("pat_token"), username=tfs_config.get("username"), password=tfs_config.get("password"), mode=mode)
        if res["status"] in ["created", "updated"]:
            success_count += 1
            created_ids.append(res["task_id"])
        elif res["status"] == "skipped":
            skipped_count += 1
        else:
            failed_count += 1
            errors.append(res.get("reason"))
        report_rows.append(res["report"])
        
    return {
        "status": "success" if failed_count == 0 else "partial",
        "success_count": success_count,
        "failed_count": failed_count,
        "skipped_count": skipped_count,
        "total": len(df),
        "created_ids": created_ids,
        "report_rows": [vars(r) for r in report_rows],
        "errors": errors
    }


def execute_task_creation(excel_file: str = None, iteration_path: str = None, tfs_config: dict = None, batch_mode: bool = False, mode: str = "create", **kwargs):
    try:
        if batch_mode and excel_file:
            import base64, tempfile
            file_bytes = base64.b64decode(excel_file)
            with tempfile.NamedTemporaryFile(delete=False, suffix='.xlsx') as tmp:
                tmp.write(file_bytes)
                tmp_path = tmp.name
            try:
                res = process_task_batch(tmp_path, iteration_path, tfs_config, mode, **kwargs)
                return {
                    "status": res["status"],
                    "summary": {
                        "created": res["success_count"] if mode == "create" else 0,
                        "updated": res["success_count"] if mode == "update" else 0,
                        "failed": res["failed_count"],
                        "skipped": res["skipped_count"],
                        "total": res["total"]
                    },
                    "report_rows": res["report_rows"],
                    "errors": res["errors"],
                    "agent": "TFS Task Agent"
                }
            finally: os.unlink(tmp_path)
        return {"status": "error", "error": "Invalid parameters"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def generate_task_excel_report(report_rows: List[Dict]) -> bytes:
    import io
    data = []
    for r in report_rows:
        data.append({
            "ID": r.get("task_id") or "",
            "Title": r.get("task_title") or "",
            "Assigned To": r.get("assigned_to_tfs") or "",
            "Original Estimate": r.get("hours") or 0,
            "Completed Work": 0,
            "Remaining Work": r.get("hours") or 0,
            "Start Date": r.get("start_date") or "",
            "Created Date": datetime.now().strftime("%d-%m-%Y")
        })
    df = pd.DataFrame(data)
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        df.to_excel(writer, index=False, sheet_name='Tasks')
    return output.getvalue()
