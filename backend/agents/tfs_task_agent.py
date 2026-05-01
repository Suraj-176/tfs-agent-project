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
    
    Args:
        value: Employee name or email
        employee_map: Dictionary mapping names to emails
        
    Returns:
        Email address or None
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

        # direct numeric
        num = float(text)
        if math.isnan(num) or math.isinf(num):
            return None
        return num
    except:
        pass

    try:
        text = str(value).strip().lower()

        # e.g. "2h", "2 hrs", "2.5 hours"
        m = re.search(r"(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\b", text)
        if m:
            num = float(m.group(1))
            if math.isnan(num) or math.isinf(num):
                return None
            return num

        # e.g. "02:30" -> 2.5
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
    
    Supports formats:
    1. Dual-header: [Employee Name] then [Date] | [TaskID] | [Task] | [Hours] | [Status]
    2. Single header: Date | TaskID | Task | Hours | Status (looks for employee column)
    
    Args:
        file_path: Path to Excel file
        sheet_name: Sheet index or name
        employee_map: Dictionary mapping employee names to emails
        
    Returns:
        DataFrame with columns: Assigned To, Date, TaskID/BugID, Task, Hours, Status
    """
    print(f"\n📖 parse_daily_tasks_excel START")
    print(f"   file_path: {file_path}")
    print(f"   sheet_name: {sheet_name}")
    
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Excel file not found: {file_path}")
    
    # Read with no headers initially - try Excel first, fall back to CSV
    try:
        raw_df = pd.read_excel(file_path, sheet_name=sheet_name, header=None, engine='openpyxl')
    except Exception as excel_err:
        # If Excel parsing fails, try CSV
        if "not a zip file" in str(excel_err).lower() or "openpyxl" in str(excel_err):
            print(f"   ⚠ Excel parsing failed ({str(excel_err)[:60]}), trying CSV format...")
            try:
                raw_df = pd.read_csv(file_path, header=None)
            except Exception as csv_err:
                raise ValueError(f"Failed to parse file as Excel or CSV: {str(csv_err)}")
        else:
            raise
    
    print(f"   📊 Raw DataFrame shape: {raw_df.shape}")
    
    if len(raw_df) == 0:
        raise ValueError("No task rows found in Excel file")
    
    print(f"   First 3 rows:")
    for i in range(min(3, len(raw_df))):
        print(f"      Row {i}: {raw_df.iloc[i].tolist()}")
    
    records = []
    current_email = None
    
    # Check if this looks like a header-based format (first row has text like "Date", "Task", etc)
    first_row_vals = [str(raw_df.iloc[0, i]).strip() if i < len(raw_df.columns) else "" for i in range(min(5, len(raw_df.columns)))]
    is_header_format = any(val.lower() in ["date", "taskid", "task", "hours", "status"] for val in first_row_vals if val)
    
    print(f"   🔍 First row values: {first_row_vals}")
    print(f"   📋 Header format detected: {is_header_format}")
    
    if is_header_format:
        print(f"   ✅ Using header-based format parsing...")
        # Try to read with headers
        try:
            df_with_header = pd.read_excel(file_path, sheet_name=sheet_name, engine='openpyxl')
        except Exception as excel_err:
            # Fall back to CSV
            if "not a zip file" in str(excel_err).lower() or "openpyxl" in str(excel_err):
                print(f"   ⚠ Excel header parsing failed, trying CSV...")
                df_with_header = pd.read_csv(file_path)
            else:
                raise
        
        print(f"   📊 Header DataFrame shape: {df_with_header.shape}")
        print(f"   📝 Column names (before normalize): {df_with_header.columns.tolist()}")
        
        # Normalize column names
        df_with_header.columns = df_with_header.columns.str.lower().str.strip()
        print(f"   📝 Column names (after normalize): {df_with_header.columns.tolist()}")
        
        # Map common column names
        col_map = {
            "date": "Date",
            "taskid": "TaskID/BugID", 
            "bugid": "TaskID/BugID",
            "task": "Task",
            "description": "Task",
            "hours": "Hours",
            "time": "Hours",
            "status": "Status",
            "employee": "Assigned To",
            "assigned to": "Assigned To",
            "name": "Assigned To",
            "assigned_to": "Assigned To",
        }
        
        # Find columns - use substring matching instead of exact match
        date_col = None
        task_id_col = None
        task_col = None
        hours_col = None
        status_col = None
        assigned_col = None
        
        print(f"   🔎 Searching for columns in: {df_with_header.columns.tolist()}")
        for col in df_with_header.columns:
            col_lower = col.lower()
            # Check for task_id/bugid FIRST before task
            if "taskid" in col_lower or "bugid" in col_lower:
                task_id_col = col
                print(f"      ✓ task_id_col = '{col}'")
            elif "date" in col_lower:
                date_col = col
                print(f"      ✓ date_col = '{col}'")
            elif "task" in col_lower or "description" in col_lower:
                task_col = col
                print(f"      ✓ task_col = '{col}'")
            elif "hours" in col_lower or "time" in col_lower:
                hours_col = col
                print(f"      ✓ hours_col = '{col}'")
            elif "status" in col_lower:
                status_col = col
                print(f"      ✓ status_col = '{col}'")
            elif "assign" in col_lower or "employee" in col_lower or "resource" in col_lower or "owner" in col_lower or (col_lower == "name"):
                assigned_col = col
                print(f"      ✓ assigned_col = '{col}'")
        
        print(f"   🎯 Found: date={date_col}, task={task_col}, task_id={task_id_col}, hours={hours_col}, status={status_col}, assigned={assigned_col}")
        
        if not (date_col and task_col):
            error_msg = f"Could not find required Date and Task columns in header format. Found: date={date_col}, task={task_col}"
            print(f"   ❌ {error_msg}")
            raise ValueError(error_msg)
        
        # Use logged-in user if no employee column found
        if not assigned_col:
            current_email = "system"  # Default to system user
        
        # Process rows
        for idx, row in df_with_header.iterrows():
            try:
                date_val = row.get(date_col)
                task_id_val = row.get(task_id_col) if task_id_col else None
                task_val = row.get(task_col)
                hours_val = row.get(hours_col) if hours_col else None
                status_val = row.get(status_col) if status_col else None
                assigned_val = row.get(assigned_col) if assigned_col else current_email
                
                # Skip empty rows
                if pd.isna(date_val) and pd.isna(task_val):
                    continue
                if pd.isna(date_val) or str(date_val).strip() == "":
                    continue
                if not task_val or str(task_val).strip() == "":
                    continue
                
                # Get email for assigned to
                email = assigned_val if assigned_val else current_email
                if assigned_col:
                    mapped_email = resolve_employee_email(email, employee_map)
                    if mapped_email:
                        email = mapped_email
                
                records.append({
                    "Assigned To": email or "system",
                    "Date": date_val,
                    "TaskID/BugID": str(task_id_val).strip() if task_id_val and not pd.isna(task_id_val) else None,
                    "Task": str(task_val).strip(),
                    "Hours": parse_hours(hours_val),
                    "Status": str(status_val).strip() if status_val and not pd.isna(status_val) else None,
                })
            except Exception as row_err:
                print(f"⚠ Skipping row {idx}: {str(row_err)}")
                continue
        
        if records:
            print(f"   ✅ Found {len(records)} valid task records")
            result_df = pd.DataFrame(records)
            print(f"   📊 Result DataFrame shape: {result_df.shape}")
            print(f"   📄 Result columns: {result_df.columns.tolist()}")
            return normalize_columns(result_df)  # ← Normalize columns to lowercase!
        else:
            error_msg = "No task rows found in Excel file"
            print(f"   ❌ {error_msg}")
            raise ValueError(error_msg)
    
    # Original dual-header format parsing
    for i in range(len(raw_df)):
        row = raw_df.iloc[i]
        
        col0 = row[0] if len(row) > 0 else None
        col1 = row[1] if len(row) > 1 else None
        col2 = row[2] if len(row) > 2 else None
        col3 = row[3] if len(row) > 3 else None
        col4 = row[4] if len(row) > 4 else None
        
        # Check for header row (employee name)
        mapped_email = resolve_employee_email(col0, employee_map)
        if mapped_email:
            current_email = mapped_email
            continue
        
        # Skip header rows
        if is_header_row(col0):
            continue
        
        # Skip empty rows
        if all(pd.isna(x) or str(x).strip() == "" for x in [col0, col1, col2, col3, col4]):
            continue
        
        # Extract fields
        date_val = col0
        task_id = None if pd.isna(col1) or str(col1).strip() == "" else str(col1).strip()
        task_text = None if pd.isna(col2) else str(col2).strip()
        hours_val = col3
        status_val = col4
        
        # Validate
        if not current_email:
            continue
        if pd.isna(date_val) or str(date_val).strip() == "":
            continue
        if not task_text:
            continue
        
        # Parse hours
        hours = parse_hours(hours_val)
        
        # Parse status
        status = None if pd.isna(status_val) or str(status_val).strip() == "" else str(status_val).strip()
        
        records.append({
            "Assigned To": current_email,
            "Date": date_val,
            "TaskID/BugID": task_id,
            "Task": task_text,
            "Hours": hours,
            "Status": status,
        })
    
    if records:
        df = pd.DataFrame(records)
        return normalize_columns(df)

    # Fallback: normal tabular Excel format with real header row.
    try:
        table_df = pd.read_excel(file_path, sheet_name=sheet_name, header=0, engine='openpyxl')
    except Exception as excel_err:
        # Fall back to CSV
        if "not a zip file" in str(excel_err).lower() or "openpyxl" in str(excel_err):
            print(f"   ⚠ Excel fallback parsing failed, trying CSV...")
            table_df = pd.read_csv(file_path, header=0)
        else:
            raise
    
    if table_df is None or table_df.empty:
        raise ValueError("No task rows found in Excel file")

    table_df = normalize_columns(table_df)
    columns = set(table_df.columns)

    normalized_cols = {c: _norm_col_key(c) for c in columns}

    def pick_col(candidates):
        candidate_keys = [_norm_col_key(c) for c in candidates]
        # exact normalized match
        for col, ncol in normalized_cols.items():
            if ncol in candidate_keys:
                return col
        # contains match (handles names like "task details", "assignee email id", etc.)
        for col, ncol in normalized_cols.items():
            for ck in candidate_keys:
                if ck and (ck in ncol or ncol in ck):
                    return col
        return None

    assigned_col = pick_col(["assigned to", "assignedto", "email", "email id", "resource", "resource email", "resource name", "employee", "employee name", "owner", "assigned_to"])
    date_col = pick_col(["date", "start date", "start_date"])
    task_col = pick_col(["task", "task description", "title", "work item", "description"])
    hours_col = pick_col(["hours", "original estimate", "estimate", "duration", "time", "time in hrs", "time(inhrs)", "time(in hrs)"])
    status_col = pick_col(["status"])
    id_col = pick_col(["taskid/bugid", "task id", "bug id", "taskid"])

    if not task_col:
        # choose text-heavy column as last guess for task
        best_col = None
        best_score = -1
        for col in table_df.columns:
            series = table_df[col].dropna().astype(str).str.strip()
            if series.empty:
                continue
            score = series.map(lambda x: len(x) if any(ch.isalpha() for ch in x) else 0).sum()
            if score > best_score:
                best_score = score
                best_col = col
        task_col = best_col
    if not task_col:
        raise ValueError("No task rows found in Excel file")

    fallback_records = []
    for _, row in table_df.iterrows():
        task_text = None if pd.isna(row.get(task_col)) else str(row.get(task_col)).strip()
        if not task_text or _is_header_like_task_text(task_text):
            continue

        assigned_raw = row.get(assigned_col) if assigned_col else None
        # Try resolve via employee map first
        assigned_email = resolve_employee_email(assigned_raw, employee_map)
        # If not found in map and value exists, use it directly (handles plain names like "john", "suraj")
        if not assigned_email and assigned_raw:
            assigned_raw_str = str(assigned_raw).strip()
            if assigned_raw_str and assigned_raw_str.lower() not in ["none", "null", "n/a", "na"]:
                assigned_email = assigned_raw_str

        date_val = row.get(date_col) if date_col else None
        if date_val is None or (pd.isna(date_val) if hasattr(pd, "isna") else False) or str(date_val).strip() == "":
            for cell in row.tolist():
                if parse_date_flexible(cell) is not None:
                    date_val = cell
                    break

        hours_val = parse_hours(row.get(hours_col)) if hours_col else None
        if hours_val is None:
            for cell in row.tolist():
                parsed_h = parse_hours(cell)
                if parsed_h is not None:
                    hours_val = parsed_h
                    break

        fallback_records.append({
            "Assigned To": assigned_email,
            "Date": date_val,
            "TaskID/BugID": row.get(id_col) if id_col else None,
            "Task": task_text,
            "Hours": hours_val,
            "Status": None if not status_col or pd.isna(row.get(status_col)) else str(row.get(status_col)).strip(),
        })

    if fallback_records:
        return normalize_columns(pd.DataFrame(fallback_records))

    # Last fallback: raw-cell heuristic parser for unconventional templates.
    try:
        heuristic_df = pd.read_excel(file_path, sheet_name=sheet_name, header=None, engine='openpyxl')
    except Exception as excel_err:
        # Fall back to CSV
        if "not a zip file" in str(excel_err).lower() or "openpyxl" in str(excel_err):
            print(f"   ⚠ Excel heuristic parsing failed, trying CSV...")
            heuristic_df = pd.read_csv(file_path, header=None)
        else:
            raise
    
    heuristic_records = []
    header_like_tokens = {
        "date", "task", "task description", "title", "status", "hours", "duration",
        "assigned to", "assignedto", "employee", "resource", "email", "email id",
        "taskid", "task id", "bugid", "bug id"
    }

    for _, row in heuristic_df.iterrows():
        values = [None if pd.isna(v) else str(v).strip() for v in row.tolist()]
        non_empty = [v for v in values if v]
        if not non_empty:
            continue

        lowered = [v.lower() for v in non_empty]
        if all(v in header_like_tokens for v in lowered):
            continue

        # Pick the longest meaningful text as task candidate.
        text_candidates = [
            v for v in non_empty
            if any(ch.isalpha() for ch in v)
            and v.lower() not in header_like_tokens
            and not ("@" in v and "." in v)
        ]
        if not text_candidates:
            continue
        task_text = sorted(text_candidates, key=lambda x: len(x), reverse=True)[0]
        if _is_header_like_task_text(task_text):
            continue

        # Find possible assignee from row (name or email)
        assigned_email = None
        for v in non_empty:
            # First try employee map resolution
            resolved = resolve_employee_email(v, employee_map)
            if resolved:
                assigned_email = resolved
                break
        
        # If no email found via map, try using the name directly if it looks like a person name
        if not assigned_email:
            for v in non_empty:
                v_str = str(v).strip()
                # Skip if it's a number, date, or obvious non-name
                if v_str and not any(ch.isdigit() for ch in v_str.split()[0] if ch not in '.,-'):
                    # This could be a person name, use it directly
                    if v_str.lower() not in ["none", "null", "n/a", "na", "task", "task title", "title"]:
                        assigned_email = v_str
                        break

        # Find date from row.
        row_date = None
        for v in non_empty:
            if parse_date_flexible(v) is not None:
                row_date = v
                break

        # Find hours from row.
        row_hours = None
        for v in non_empty:
            h = parse_hours(v)
            if h is not None:
                row_hours = h
                break

        heuristic_records.append({
            "Assigned To": assigned_email,
            "Date": row_date,
            "TaskID/BugID": None,
            "Task": task_text,
            "Hours": row_hours,
            "Status": None,
        })

    if heuristic_records:
        return normalize_columns(pd.DataFrame(heuristic_records))

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
    
    Args:
        row: Task row from DataFrame
        iteration_path: TFS iteration path
        skip_duplicates: Skip if task already exists
        base_url: TFS base URL
        pat: TFS PAT token
        domain: TFS domain name
        logger: Logger function
        mode: "create" or "update"
        
    Returns:
        {
            "status": "created" | "updated" | "skipped" | "failed",
            "task_id": int,
            "reason": str,
            "report": TaskReport,
        }
    """
    if logger is None:
        logger = print
    
    # Extract title
    task_title = get_col_value(row, ["task", "task description", "title"])
    if not task_title:
        return {
            "status": "skipped",
            "reason": "Missing title",
            "report": TaskReport(
                resource_email="",
                assigned_to_tfs="",
                task_title="",
                status="Skipped",
                reason="Missing title"
            ),
        }

    # Skip common header-like pseudo task rows.
    if _is_header_like_task_text(task_title):
        return {
            "status": "skipped",
            "reason": "Header row",
            "report": TaskReport(
                resource_email="",
                assigned_to_tfs="",
                task_title=task_title,
                status="Skipped",
                reason="Header row"
            ),
        }
    
    # Skip leave entries
    if "leave" in task_title.lower():
        return {
            "status": "skipped",
            "reason": "Leave entry",
            "report": TaskReport(
                resource_email="",
                assigned_to_tfs="",
                task_title=task_title,
                status="Skipped",
                reason="Leave entry"
            ),
        }
    
    # Check for existing task_id in CSV (for updates)
    task_id_raw = get_col_value(row, ["id", "task id", "taskid", "work item id", "workitemid", "wi id", "taskid/bugid"])
    task_id_to_update = None
    try:
        if task_id_raw and str(task_id_raw).strip() and str(task_id_raw).strip().lower() not in ["none", "null", "nan", ""]:
            # Handle both int and float formats (e.g., "12345" or "12345.0")
            task_id_str = str(task_id_raw).strip()
            task_id_to_update = int(float(task_id_str))
            logger(f"   Task ID from CSV: {task_id_to_update}")
    except (ValueError, TypeError):
        task_id_to_update = None

    # VALIDATION: If mode is "update" but no Task ID is provided
    if mode == "update" and not task_id_to_update:
        reason = "Skipped: 'Update' mode selected but no Task ID provided for this row."
        logger(f"⚠️  {reason}")
        return {
            "status": "skipped",
            "reason": reason,
            "report": TaskReport(
                resource_email="",
                assigned_to_tfs="",
                task_title=task_title,
                status="Skipped",
                reason=reason
            ),
        }

    # Get assignee from CSV
    assigned_email = get_col_value(row, ["assigned to", "assignedto", "email", "email id", "resource", "resource name", "resource email", "employee", "employee name", "owner"])
    logger(f"   Assignee from CSV: '{assigned_email}'")
    assigned_tfs = resolve_tfs_identity(assigned_email, domain, base_url, pat, username, password) if assigned_email else None
    logger(f"   Resolved to TFS: '{assigned_tfs}'")
    
    # Use default if no assignee found in CSV
    if not assigned_tfs and default_assigned_to:
        assigned_tfs = default_assigned_to
        logger(f"   ⚠️  CSV assignee empty, using default: {assigned_tfs}")
    
    # If still no assignee, skip this task with clear guidance
    if not assigned_tfs:
        reason = "Missing assignee: CSV row has no 'Assigned To' value and no default TFS username configured. Please either: (1) Add 'Assigned To' column to CSV, or (2) Provide 'username' in TFS config"
        logger(f"⚠️  {reason}")
        return {
            "status": "skipped",
            "reason": reason,
            "report": TaskReport(
                resource_email=assigned_email or "",
                assigned_to_tfs="",
                task_title=task_title,
                status="Skipped",
                reason=reason
            ),
        }
    
    # Parse dates
    start_raw = get_col_value(row, ["date", "start date"])
    if not start_raw:
        for cell in row.tolist():
            if parse_date_flexible(cell) is not None:
                start_raw = cell
                break
    if not start_raw:
        # Fall back to current date when sheet does not provide a date column/value.
        start_raw = datetime.utcnow().strftime("%Y-%m-%d")
        logger(f"Info: Missing start date for '{task_title}', using current date {start_raw}")
    
    start_date = to_tfs_date(start_raw, end_of_day=False)
    finish_date = to_tfs_date(start_raw, end_of_day=True)
    
    # Parse hours
    hours_raw = get_col_value(row, ["hours", "original estimate", "estimate", "duration", "time", "time in hrs", "time(inhrs)", "time(in hrs)"])
    if hours_raw is None:
        for cell in row.tolist():
            maybe_hours = parse_hours(cell)
            if maybe_hours is not None:
                hours_raw = maybe_hours
                break
    hours = parse_hours(hours_raw)
    
    # Check duplicates (only if creating)
    if mode == "create" and skip_duplicates and not task_id_to_update:
        try:
            existing_id = find_existing_task(
                task_title,
                assigned_tfs,
                start_date,
                base_url,
                pat,
                username=username,
                password=password,
                domain=domain,
            )
            if existing_id:
                return {
                    "status": "skipped",
                    "reason": f"Duplicate (ID: {existing_id})",
                    "report": TaskReport(
                        resource_email=assigned_email or "",
                        assigned_to_tfs=assigned_tfs,
                        task_title=task_title,
                        task_id=existing_id,
                        status="Skipped",
                        reason="Duplicate task already exists",
                        iteration_path=iteration_path,
                        hours=hours,
                        start_date=start_date,
                        finish_date=finish_date,
                    ),
                }
        except Exception as e:
            logger(f"Warning: Duplicate check failed: {e}")
    
    # Create or Update task
    try:
        if task_id_to_update:
            # UPDATE existing task
            logger(f"📝 Updating task {task_id_to_update}: {task_title}")
            response = update_task(
                task_id=task_id_to_update,
                title=task_title,
                assigned_to=assigned_tfs,
                start_date=start_date,
                finish_date=finish_date,
                original_estimate=hours,
                iteration_path=iteration_path,
                base_url=base_url,
                pat=pat,
                username=username,
                password=password,
                domain=domain,
            )
            
            if response and response.status_code in [200, 201]:
                data = response.json()
                fields = data.get("fields", {})
                
                return {
                    "status": "updated",
                    "task_id": task_id_to_update,
                    "report": TaskReport(
                        resource_email=assigned_email or "",
                        assigned_to_tfs=fields.get("System.AssignedTo", assigned_tfs),
                        task_title=fields.get("System.Title", task_title),
                        task_id=task_id_to_update,
                        status="Updated",
                        reason="Task updated successfully",
                        iteration_path=fields.get("System.IterationPath", iteration_path),
                        hours=fields.get("Microsoft.VSTS.Scheduling.OriginalEstimate") or hours,
                        start_date=fields.get("Microsoft.VSTS.Scheduling.StartDate", start_date),
                        finish_date=fields.get("Microsoft.VSTS.Scheduling.FinishDate", finish_date),
                    ),
                }
            else:
                # Better error handling
                if response is None:
                    reason_text = "No response from server (request failed silently)"
                elif response.status_code == 401:
                    reason_text = "Authentication failed (401). Check PAT token or username/password."
                elif response.status_code == 404:
                    reason_text = f"Task {task_id_to_update} not found (404)"
                elif response.status_code == 400:
                    try:
                        error_data = response.json()
                        reason_text = error_data.get("message", response.text[:200])
                    except:
                        reason_text = f"Bad request (400): {response.text[:200]}"
                else:
                    reason_text = f"HTTP {response.status_code}: {response.text[:200]}"
                
                logger(f"❌ Update failed: {reason_text}")
                return {
                    "status": "failed",
                    "reason": f"Update failed: {reason_text}",
                    "report": TaskReport(
                        resource_email=assigned_email or "",
                        assigned_to_tfs=assigned_tfs,
                        task_title=task_title,
                        task_id=task_id_to_update,
                        status="Failed",
                        reason=reason_text,
                        iteration_path=iteration_path,
                        hours=hours,
                        start_date=start_date,
                        finish_date=finish_date,
                    ),
                }
        else:
            # CREATE new task
            logger(f"➕ Creating new task: {task_title}")
            response = create_task(
                title=task_title,
                assigned_to=assigned_tfs,
                start_date=start_date,
                finish_date=finish_date,
                original_estimate=hours,
                iteration_path=iteration_path,
                base_url=base_url,
                pat=pat,
                username=username,
                password=password,
                domain=domain,
            )
        
        if response.status_code in [200, 201]:
            data = response.json()
            task_id = data.get("id")
            fields = data.get("fields", {})
            
            return {
                "status": "created",
                "task_id": task_id,
                "report": TaskReport(
                    resource_email=assigned_email or "",
                    assigned_to_tfs=fields.get("System.AssignedTo", assigned_tfs),
                    task_title=fields.get("System.Title", task_title),
                    task_id=task_id,
                    status="Created",
                    reason="Task created successfully",
                    iteration_path=fields.get("System.IterationPath", iteration_path),
                    hours=fields.get("Microsoft.VSTS.Scheduling.OriginalEstimate") or hours,
                    start_date=fields.get("Microsoft.VSTS.Scheduling.StartDate", start_date),
                    finish_date=fields.get("Microsoft.VSTS.Scheduling.FinishDate", finish_date),
                ),
            }
        else:
            reason_text = response.text[:200]
            if response.status_code == 401:
                reason_text = (
                    "Authentication failed (401 TF400813). "
                    "Check username/password format or provide PAT if required by server policy."
                )
            return {
                "status": "failed",
                "reason": f"API error {response.status_code}: {reason_text}",
                "report": TaskReport(
                    resource_email=assigned_email or "",
                    assigned_to_tfs=assigned_tfs,
                    task_title=task_title,
                    status="Failed",
                    reason=reason_text,
                    iteration_path=iteration_path,
                    hours=hours,
                    start_date=start_date,
                    finish_date=finish_date,
                ),
            }
    
    except Exception as e:
        return {
            "status": "failed",
            "reason": str(e),
            "report": TaskReport(
                resource_email=assigned_email or "",
                assigned_to_tfs=assigned_tfs,
                task_title=task_title,
                status="Failed",
                reason=str(e),
                iteration_path=iteration_path,
                hours=hours,
                start_date=start_date,
                finish_date=finish_date,
            ),
        }


def process_task_batch(
    excel_file: str,
    iteration_path: str,
    sheet_name=None,
    skip_duplicates: bool = True,
    tfs_config: dict = None,
    employee_map: dict = None,
    logger=None,
    mode: str = "create"  # Added mode parameter
) -> Dict:
    """
    Process batch of tasks from Excel file with error recovery
    
    Args:
        excel_file: Path to Excel file
        iteration_path: TFS iteration path
        skip_duplicates: Skip duplicate tasks
        tfs_config: TFS configuration dict
        employee_map: Employee name to email mapping
        logger: Logger function
        mode: "create" or "update"
        
    Returns:
        {
            "status": "success" | "partial" | "error",
            "success_count": int,
            "failed_count": int,
            "skipped_count": int,
            "total": int,
            "created_ids": list,
            "report_rows": list of TaskReport dicts,
            "errors": list,
        }
    """
    if logger is None:
        logger = print
    
    tfs_config = tfs_config or {}
    username = (tfs_config.get("username") or "").strip()
    password = tfs_config.get("password") or ""
    pat_token = (tfs_config.get("pat_token") or "").strip()
    base_url = (tfs_config.get("base_url") or "").strip()
    auth_mode = "pat" if pat_token else ("username_password" if (username and password) else "none")
    domain = (tfs_config.get("domain") or "DGSL").strip() or "DGSL"
    
    # Calculate default assignee from config
    if "\\" in username:
        default_assigned_to = username
    elif "@" in username:
        default_assigned_to = resolve_tfs_identity(username, domain, base_url, pat_token, username, password)
    elif username:
        default_assigned_to = resolve_tfs_identity(username, domain, base_url, pat_token, username, password)
    else:
        default_assigned_to = None
    
    logger(f"📋 Processing bulk tasks | Auth: {auth_mode} | Domain: {domain} | Default Assignee: {default_assigned_to or 'NONE'} | Mode: {mode}")
    logger(f"⚙️ Config: {json.dumps(sanitize_params(tfs_config), indent=2)}")

    # Prevent anonymous API requests.
    if not pat_token and not (username and password):
        raise ValueError("Authentication required: provide PAT, or both username and password.")
    
    try:
        logger(f"📖 Reading Excel file: {excel_file}")
        
        # Parse Excel (try selected sheet first, then all sheets as fallback)
        selected_sheet = 0 if sheet_name in [None, ""] else sheet_name
        try:
            df = parse_daily_tasks_excel(excel_file, sheet_name=selected_sheet, employee_map=employee_map)
            logger(f"✓ Parsed {len(df)} task rows")
        except Exception as first_ex:
            first_msg = str(first_ex)
            if "No task rows found in Excel file" not in first_msg:
                raise

            logger(f"⚠ Selected sheet '{selected_sheet}' had no parsable rows. Trying all sheets...")
            try:
                xls = pd.ExcelFile(excel_file, engine='openpyxl')
                sheet_names = xls.sheet_names
            except Exception as excel_err:
                # If it's a CSV file, skip multi-sheet attempt
                if "not a zip file" in str(excel_err).lower() or "openpyxl" in str(excel_err):
                    logger(f"   ⚠ File is not Excel format (likely CSV), skipping multi-sheet fallback")
                    sheet_names = []
                else:
                    raise
            
            parsed = None
            for s in sheet_names:
                try:
                    candidate = parse_daily_tasks_excel(excel_file, sheet_name=s, employee_map=employee_map)
                    if candidate is not None and len(candidate) > 0:
                        parsed = candidate
                        logger(f"✓ Parsed {len(candidate)} task rows from sheet: {s}")
                        break
                except Exception:
                    continue
            if parsed is None:
                raise ValueError("No task rows found in any sheet of the Excel file")
            df = parsed
        
        # Validate iteration path
        if not iteration_path or str(iteration_path).strip() == "":
            raise ValueError("Iteration path is required")
        
        logger(f"📍 Using iteration path: {iteration_path}")
        logger(f"📊 DataFrame shape: {df.shape}")
        logger(f"📝 DataFrame columns: {df.columns.tolist()}")
        logger(f"📄 First 2 rows:")
        for i in range(min(2, len(df))):
            logger(f"   Row {i}: {df.iloc[i].to_dict()}")
        
        # Initialize counters
        success_count = 0
        failed_count = 0
        skipped_count = 0
        created_ids = []
        report_rows = []
        errors = []
        
        # Process each task with error recovery
        for idx, row in df.iterrows():
            try:
                result = process_single_task(
                    row,
                    iteration_path=iteration_path,
                    skip_duplicates=skip_duplicates,
                    base_url=tfs_config.get("base_url"),
                    pat=tfs_config.get("pat_token"),
                    username=tfs_config.get("username"),
                    password=tfs_config.get("password"),
                    domain=domain,
                    default_assigned_to=default_assigned_to,
                    logger=logger,
                    mode=mode
                )
                
                if result["status"] == "created":
                    success_count += 1
                    created_ids.append(result["task_id"])
                    logger(f"✓ Created task {result['task_id']}: {result['report'].task_title}")
                elif result["status"] == "updated":
                    success_count += 1
                    created_ids.append(result["task_id"])
                    logger(f"✓ Updated task {result['task_id']}: {result['report'].task_title}")
                elif result["status"] == "skipped":
                    skipped_count += 1
                    logger(f"⊘ Skipped: {result.get('reason', 'No reason provided')}")
                else:
                    failed_count += 1
                    logger(f"✗ Failed: {result.get('reason', 'Unknown error')}")
                    errors.append(result.get("reason", "Unknown error"))
                
                report_rows.append(result["report"])
            
            except Exception as e:
                failed_count += 1
                error_msg = f"Row {idx + 1} error: {str(e)}"
                logger(error_msg)
                errors.append(error_msg)
        
        # Summary
        logger("\n" + "=" * 50)
        logger("📊 BATCH EXECUTION SUMMARY")
        logger(f"✓ Success : {success_count}")
        logger(f"✗ Failed  : {failed_count}")
        logger(f"⊘ Skipped : {skipped_count}")
        logger(f"📋 Total   : {len(df)}")
        logger("=" * 50)
        
        return {
            "status": "success" if failed_count == 0 else "partial",
            "success_count": success_count,
            "failed_count": failed_count,
            "skipped_count": skipped_count,
            "total": len(df),
            "created_ids": created_ids,
            "report_rows": [vars(r) for r in report_rows],
            "errors": errors,
            "auth_mode": auth_mode,
        }
    
    except Exception as e:
        error_msg = f"Batch processing failed: {str(e)}"
        logger(error_msg)
        return {
            "status": "error",
            "error": error_msg,
            "report_rows": [],
        }


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
    mode: str = "create"  # Added mode parameter
):
    """
    Execute task creation with three modes:
    - BULK mode: Batch processing from Excel file
    - CREATE mode: Create new task from description
    - UPDATE mode: Update existing task
    
    Args:
        work_item_id: Task ID to UPDATE (if provided)
        task_description: Description to CREATE new task
        excel_file: Base64 encoded Excel file for BULK mode
        batch_mode: Set to true for bulk processing
        iteration_path: Target iteration path
        llm_config: LLM configuration
        tfs_config: TFS configuration
        sheet_name: Excel sheet name (optional)
        
    Returns:
        Success/error response
    """
    # Open log file for debugging
    import os as os_module
    log_path = os_module.path.join(os_module.path.dirname(__file__), '..', '..', 'logs', 'bulk_processing.log')
    os_module.makedirs(os_module.path.dirname(log_path), exist_ok=True)
    
    def log_to_file(msg):
        """Log message to both stdout and file"""
        print(msg)
        try:
            with open(log_path, 'a', encoding='utf-8') as f:
                f.write(msg + '\n')
        except:
            pass
    
    try:
        log_to_file(f"\n{'='*70}")
        log_to_file(f"📌 execute_task_creation START at {__import__('datetime').datetime.now().isoformat()}")
        log_to_file(f"  ✓ batch_mode: {batch_mode} (type: {type(batch_mode).__name__})")
        log_to_file(f"  ✓ excel_file: {'<present>' if excel_file else '<NULL>'} (length: {len(excel_file) if excel_file else 0})")
        log_to_file(f"  ✓ iteration_path: {iteration_path}")
        log_to_file(f"  ✓ sheet_name: {sheet_name}")
        log_to_file(f"  ✓ work_item_id: {work_item_id}")
        log_to_file(f"  ✓ task_description: {task_description[:50] if task_description else '<empty>'}...")
        
        # Check actual conditions
        log_to_file(f"  🔍 Condition checks:")
        log_to_file(f"     batch_mode AND excel_file: {batch_mode and excel_file}")
        log_to_file(f"     work_item_id AND work_item_id > 0: {work_item_id and work_item_id > 0}")
        log_to_file(f"     task_description AND len > 0: {task_description and len(task_description) > 0}")
        
        # BULK MODE: Process Excel file
        if batch_mode and excel_file:
            import base64
            import tempfile
            import os
            
            log_to_file(f"  📝 Bulk mode detected, processing Excel file...")
            
            try:
                log_to_file(f"  🔐 Decoding base64 Excel file ({len(excel_file)} chars)...")
                file_bytes = base64.b64decode(excel_file)
                log_to_file(f"  ✅ Decoded {len(file_bytes)} bytes")
            except Exception as e:
                error_msg = f"Failed to decode Excel file: {str(e)}"
                log_to_file(f"  ❌ {error_msg}")
                return {
                    "status": "error",
                    "error": error_msg,
                    "summary": {"created": 0, "failed": 0, "updated": 0, "total": 0},
                    "created_ids": [],
                    "updated_ids": [],
                    "report_rows": [],
                    "errors": [error_msg],
                    "agent": "TFS Task Agent (Bulk)",
                }
            
            # Write to temporary file
            try:
                with tempfile.NamedTemporaryFile(delete=False, suffix='.xlsx') as tmp:
                    tmp.write(file_bytes)
                    tmp_path = tmp.name
                log_to_file(f"  💾 Temp file created: {tmp_path}")
            except Exception as e:
                error_msg = f"Failed to create temp file: {str(e)}"
                log_to_file(f"  ❌ {error_msg}")
                return {
                    "status": "error",
                    "error": error_msg,
                    "summary": {"created": 0, "failed": 0, "updated": 0, "total": 0},
                    "created_ids": [],
                    "updated_ids": [],
                    "report_rows": [],
                    "errors": [error_msg],
                    "agent": "TFS Task Agent (Bulk)",
                }
            
            try:
                # Process batch file
                log_to_file(f"  🔄 Calling process_task_batch with mode={mode}...")
                result = process_task_batch(
                    excel_file=tmp_path,
                    iteration_path=iteration_path,
                    sheet_name=sheet_name,
                    skip_duplicates=skip_duplicates,
                    tfs_config=tfs_config,
                    logger=print,
                    mode=mode
                )
                log_to_file(f"  ✅ process_task_batch returned: status={result.get('status')}, success_count={result.get('success_count')}")
                
                # If process_task_batch returned an error, capture it
                error_details = []
                if result.get("error"):
                    error_details.append(result.get("error"))
                if result.get("errors"):
                    error_details.extend(result.get("errors"))
                
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
                    "error": result.get("error"),
                    "errors": error_details,
                    "agent": "TFS Task Agent (Bulk)",
                }
            except Exception as batch_error:
                print(f"❌ Batch processing error: {str(batch_error)}")
                import traceback
                traceback.print_exc()
                return {
                    "status": "error",
                    "error": f"Batch processing failed: {str(batch_error)}",
                    "summary": {"created": 0, "failed": 0, "updated": 0, "total": 0},
                    "created_ids": [],
                    "updated_ids": [],
                    "report_rows": [],
                    "errors": [str(batch_error)],
                    "agent": "TFS Task Agent (Bulk)",
                }
            finally:
                # Clean up temp file
                try:
                    os.unlink(tmp_path)
                except:
                    pass
        
        # UPDATE MODE: work_item_id provided
        elif work_item_id and work_item_id > 0:
            agent = create_tfs_task_agent(llm_config)
            
            tfs_base_url = tfs_config.get("base_url") if tfs_config else None
            tfs_username = tfs_config.get("username") if tfs_config else None
            tfs_password = tfs_config.get("password") if tfs_config else None
            tfs_pat = tfs_config.get("pat_token") if tfs_config else None
            
            # Fetch the existing task
            try:
                existing_task = fetch_user_story(
                    work_item_id,
                    base_url=tfs_base_url,
                    username=tfs_username,
                    password=tfs_password,
                    pat=tfs_pat
                )
                fetch_status = "✅ Task fetched successfully"
            except Exception as e:
                existing_task = ""
                fetch_status = f"⚠️ Could not fetch task {work_item_id}: {str(e)}"
            
            task = Task(
                description=f"""
You are updating an existing TFS task (ID: {work_item_id}).

Current task details:
{existing_task if existing_task else "(Could not fetch)"}

Update request:
{task_description if task_description else "(No specific updates provided)"}

Your job:
1. Analyze the existing task and the update request
2. If task_description is empty, suggest improvements to the existing task
3. If task_description contains updates, incorporate them
4. Generate an enhanced version with:
   - Clearer title (if needed)
   - Better description
   - Subtasks (3-5 if applicable)
   - Effort estimates
   - Dependencies

Output format:
UPDATED TASK ID: {work_item_id}
Title: [Task Title]
Description: [Enhanced Description]
[Include any subtasks, effort estimates, and dependencies as applicable]
""",
                agent=agent,
                expected_output="Updated task details for TFS work item"
            )
            
            crew = Crew(
                agents=[agent],
                tasks=[task],
                verbose=True
            )
            
            result = crew.kickoff()
            return {
                "status": "success",
                "result": str(result),
                "agent": "TFS Task Agent (Update Mode)",
                "task_id": work_item_id,
                "operation": "UPDATE",
                "fetch_status": fetch_status
            }
        
        # CREATE MODE: task_description provided
        elif task_description and task_description.strip():
            agent = create_tfs_task_agent(llm_config)
            
            task = Task(
                description=f"""
Create and break down the following requirement into 3-5 actionable subtasks:

Requirement:
{task_description}

Requirements:
- Identify 3-5 subtasks that decompose this requirement
- Provide clear, actionable task titles
- Estimate effort for each task
- Identify task dependencies
- Format as structured task definitions

Output format:
Task #1: [Title]
- Description: [What needs to be done]
- Effort: [T-shirt size: XS/S/M/L/XL]
- Dependencies: [List any dependencies]

[Repeat for each task]
""",
                agent=agent,
                expected_output="Structured task breakdown for TFS work items"
            )
            
            crew = Crew(
                agents=[agent],
                tasks=[task],
                verbose=True
            )
            
            result = crew.kickoff()
            return {
                "status": "success",
                "result": str(result),
                "agent": "TFS Task Agent (Create Mode)",
                "operation": "CREATE"
            }
        
        # Fallback: no valid input
        else:
            return {
                "status": "error",
                "error": "Please provide: (1) Excel file for bulk, (2) task_description to CREATE, or (3) work_item_id to UPDATE",
            }

    except Exception as e:
        error_msg = str(e)
        log_to_file(f"\n❌ execute_task_creation EXCEPTION: {error_msg}")
        import traceback
        log_to_file(traceback.format_exc())
        return {
            "status": "error",
            "error": error_msg,
            "summary": {"created": 0, "failed": 0, "updated": 0, "total": 0},
            "created_ids": [],
            "updated_ids": [],
            "report_rows": [],
            "errors": [error_msg],
            "agent": "TFS Task Agent (Bulk)",
        }
    
def generate_task_excel_report(report_rows: List[Dict]) -> bytes:
    """
    Generate an Excel report from task execution results
    
    Args:
        report_rows: List of task report dictionaries
        
    Returns:
        Excel file content as bytes
    """
    import io
    import pandas as pd
    
    if not report_rows:
        # Create empty template if no rows
        df = pd.DataFrame(columns=[
            "ID", "Title", "Assigned To", "Original Estimate", 
            "Completed Work", "Remaining Work", "Start Date", "Created Date"
        ])
    else:
        # Map report fields to template columns
        data = []
        for r in report_rows:
            # Determine dates
            start_date = r.get("start_date") or ""
            # Format date if it's in TFS format (ISO)
            if start_date and "T" in start_date:
                try:
                    start_date = datetime.fromisoformat(start_date.split(".")[0]).strftime("%d-%m-%Y")
                except:
                    pass
            
            created_date = datetime.now().strftime("%d-%m-%Y")
            
            # Hours logic
            orig_est = r.get("hours") or 0
            comp_work = 0 # As per user request: "completed should be 0 only"
            rem_work = orig_est
            
            data.append({
                "ID": r.get("task_id") or "",
                "Title": r.get("task_title") or "",
                "Assigned To": r.get("assigned_to_tfs") or r.get("resource_email") or "",
                "Original Estimate": orig_est,
                "Completed Work": comp_work,
                "Remaining Work": rem_work,
                "Start Date": start_date,
                "Created Date": created_date
            })
        
        df = pd.DataFrame(data)
    
    # Write to Excel in memory
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        df.to_excel(writer, index=False, sheet_name='Tasks')
    
    return output.getvalue()

